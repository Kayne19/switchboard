//! A project session's turn: whether a caller's prompt is being collected,
//! a self-woken run is held, both, or neither, and where each frame of the
//! session's turn goes. `TurnState::step` is the table and the only writer;
//! `project_session.rs` steps it from the session's pump and prompts, and
//! does what each step leaves to do (`docs/host-link.md`, "A project
//! session's turn").
use crate::pi_client::STREAM_LIMIT;
use serde_json::Value;

/// What reaches a turn while it is being collected.
pub(crate) enum TurnFrame {
    Event { seq: u64, event: Value },
    Snapshot { seq: u64, info: Value },
}

pub(crate) type Collector = tokio::sync::mpsc::UnboundedSender<TurnFrame>;

/// A self-woken run the session holds: a turn the host opened that no
/// caller's prompt collects (a subagent finished, a schedule, a turn the
/// host rebuilt after a restart). It keeps its own text and its authority
/// for module calls until the host settles it.
struct SelfWokenRun {
    turn_id: Option<String>,
    cause: String,
    text: Vec<String>,
}

impl SelfWokenRun {
    fn new(start: &TurnBoundary) -> Self {
        Self {
            turn_id: start.turn_id.clone(),
            cause: start.cause.clone(),
            text: Vec::new(),
        }
    }

    /// Whether a frame stamped `turn_id` is this run's. Modern hosts stamp
    /// every frame; a mismatched or missing id is another turn's.
    fn owns(&self, turn_id: Option<&str>) -> bool {
        self.turn_id.as_deref() == turn_id
    }

    /// Keeps `text`, as long as the run's text stays under the stream limit.
    fn append(&mut self, text: &str) {
        let collected = self.text.iter().map(String::len).sum::<usize>();
        if collected.saturating_add(text.len()) <= STREAM_LIMIT {
            self.text.push(text.to_owned());
        }
    }

    /// The run's end: its report, and its final text for the debug page.
    fn end(self, how: RunEnding) -> RunEnd {
        let kept = self.text.join("\n").trim().to_owned();
        let (text, reported) = match how {
            RunEnding::Settled { last_text } if kept.is_empty() => (last_text.to_owned(), true),
            RunEnding::Settled { .. } => (kept, true),
            RunEnding::CutShort => (kept, false),
        };
        RunEnd {
            report: TurnBoundary {
                turn_id: self.turn_id,
                cause: self.cause,
                ended: true,
                text: if reported {
                    text.clone()
                } else {
                    String::new()
                },
                cut_short: !reported,
            },
            final_text: text,
        }
    }
}

/// How a self-woken run ends.
enum RunEnding<'a> {
    /// The host settled it. `last_text` stands in for a run that kept no
    /// text, and the report carries the text.
    Settled { last_text: &'a str },
    /// Its session closed under it. Its words stay off the caller's
    /// transcript: the report carries none.
    CutShort,
}

/// A self-woken run's end, as the pump reports it: its final text goes to
/// the debug page first, then the report to the application.
pub(crate) struct RunEnd {
    pub(crate) report: TurnBoundary,
    pub(crate) final_text: String,
}

/// A turn boundary as the pump reports it to the application
/// (`ProjectInner::report_turn` stamps it with the session).
pub(crate) struct TurnBoundary {
    pub(crate) turn_id: Option<String>,
    pub(crate) cause: String,
    pub(crate) ended: bool,
    pub(crate) text: String,
    /// A self-woken run's end because its session closed under it: the host
    /// never settled it (`RunEnding::CutShort`).
    pub(crate) cut_short: bool,
}

impl TurnBoundary {
    fn opened(turn_id: Option<String>, cause: String) -> Self {
        Self {
            turn_id,
            cause,
            ended: false,
            text: String::new(),
            cut_short: false,
        }
    }
}

/// Where a project session's turn is. `TurnState::step` is its only
/// writer (`docs/host-link.md`, "A project session's turn").
enum TurnPhase {
    /// No turn.
    Idle,
    /// A caller's prompt is being collected: the turn's frames go to it.
    Caller { collector: Collector },
    /// A self-woken run is held: it keeps its own text, and no other turn's
    /// frame reaches anyone while it is held.
    SelfWoken { run: SelfWokenRun },
    /// The application admitted a self-woken run while a caller's prompt was
    /// still being collected. It does so only once the caller's turn has
    /// settled on the host, so the run is behind that turn, and swallows its
    /// frames as it would alone.
    CallerAndSelfWoken {
        collector: Collector,
        run: SelfWokenRun,
    },
    /// That run ended before the caller's prompt let go of its collector:
    /// the frames reach the collector again, and the session is not busy.
    CallerSettled { collector: Collector },
}

impl TurnPhase {
    fn collector(&self) -> Option<&Collector> {
        match self {
            Self::Caller { collector }
            | Self::CallerAndSelfWoken { collector, .. }
            | Self::CallerSettled { collector } => Some(collector),
            Self::Idle | Self::SelfWoken { .. } => None,
        }
    }

    fn run(&self) -> Option<&SelfWokenRun> {
        match self {
            Self::SelfWoken { run } | Self::CallerAndSelfWoken { run, .. } => Some(run),
            Self::Idle | Self::Caller { .. } | Self::CallerSettled { .. } => None,
        }
    }

    /// Hands `frame` to the caller's prompt being collected, if there is one.
    fn forward(&self, frame: TurnFrame) -> Vec<TurnEffect> {
        self.collector()
            .map(|collector| vec![TurnEffect::Forward(collector.clone(), frame)])
            .unwrap_or_default()
    }

    /// A frame no turn of its own took: it goes to the caller's prompt,
    /// unless a held run swallows it.
    fn pass_on(&self, frame: TurnFrame) -> Vec<TurnEffect> {
        if self.run().is_some() {
            return Vec::new();
        }
        self.forward(frame)
    }

    /// The phase with `run` held, or this one unchanged when it holds one
    /// already.
    fn holding(self, run: SelfWokenRun) -> Self {
        match self {
            Self::Idle => Self::SelfWoken { run },
            Self::Caller { collector } | Self::CallerSettled { collector } => {
                Self::CallerAndSelfWoken { collector, run }
            }
            held @ (Self::SelfWoken { .. } | Self::CallerAndSelfWoken { .. }) => held,
        }
    }

    /// The phase after the held run ends, and the run's end.
    fn ending_run(self, how: RunEnding) -> (Self, Vec<TurnEffect>) {
        match self {
            Self::SelfWoken { run } => (Self::Idle, vec![TurnEffect::RunEnded(run.end(how))]),
            Self::CallerAndSelfWoken { collector, run } => (
                Self::CallerSettled { collector },
                vec![TurnEffect::RunEnded(run.end(how))],
            ),
            other @ (Self::Idle | Self::Caller { .. } | Self::CallerSettled { .. }) => {
                (other, Vec::new())
            }
        }
    }

    /// The held run ends, settled, and the run `start` opens is held in its
    /// place. A phase that holds no run is left as it is.
    fn replacing(self, start: TurnBoundary) -> (Self, Vec<TurnEffect>) {
        let run = SelfWokenRun::new(&start);
        let replaced = |held: SelfWokenRun| TurnEffect::RunReplaced {
            ended: held.end(RunEnding::Settled { last_text: "" }),
            started: start,
        };
        match self {
            Self::SelfWoken { run: held } => (Self::SelfWoken { run }, vec![replaced(held)]),
            Self::CallerAndSelfWoken {
                collector,
                run: held,
            } => (
                Self::CallerAndSelfWoken { collector, run },
                vec![replaced(held)],
            ),
            other @ (Self::Idle | Self::Caller { .. } | Self::CallerSettled { .. }) => {
                (other, Vec::new())
            }
        }
    }
}

/// What moves a project session's turn.
pub(crate) enum TurnEvent {
    /// A caller's prompt is going out; its turn's frames go to `Collector`.
    PromptStarted(Collector),
    /// The prompt with this collector let go of it: it returned, or it was
    /// cancelled.
    PromptEnded(Collector),
    /// The host's reply to the prompt named the turn it went into: a new
    /// one, or one already open (`follow_up`).
    PromptReplied { turn_id: String },
    /// A session event from its host, in the order the host sent them.
    Event { seq: u64, event: Value },
    /// A snapshot of the session from its host: it replaces what the
    /// service knew about the session's turn.
    Snapshot { seq: u64, info: Value },
    /// The application's answer to a self-woken start it was asked to admit
    /// (`TurnEffect::AskAdmission`), with the start and its frame.
    Admitted {
        admitted: bool,
        start: TurnBoundary,
        frame: TurnFrame,
    },
}

/// What a step of the turn leaves to do once the turn's lock is released,
/// in order.
pub(crate) enum TurnEffect {
    /// Hand the frame to the caller's prompt being collected.
    Forward(Collector, TurnFrame),
    /// Report a turn boundary to the application; its answer is not used.
    Report(TurnBoundary),
    /// Ask the application whether it admits a self-woken start as an
    /// operation of its own, and step its answer (`TurnEvent::Admitted`).
    AskAdmission(TurnBoundary, TurnFrame),
    /// A self-woken run ended: publish its final text to the debug page,
    /// then report its end.
    RunEnded(RunEnd),
    /// The held run ended because the host has another turn open, which is
    /// held in its place: publish the ended run's final text, then report
    /// the new run's start with that end, for the application to take
    /// together (`ProjectTurn::replaces`).
    RunReplaced {
        ended: RunEnd,
        started: TurnBoundary,
    },
}

/// A project session's turn.
pub(crate) struct TurnState {
    phase: TurnPhase,
}

impl TurnState {
    pub(crate) fn new() -> Self {
        Self {
            phase: TurnPhase::Idle,
        }
    }

    pub(crate) fn busy(&self) -> bool {
        match self.phase {
            TurnPhase::Caller { .. }
            | TurnPhase::SelfWoken { .. }
            | TurnPhase::CallerAndSelfWoken { .. } => true,
            TurnPhase::Idle | TurnPhase::CallerSettled { .. } => false,
        }
    }

    /// The cause of the self-woken run held, if any: the authority of a
    /// module call that names no turn.
    pub(crate) fn self_woken_cause(&self) -> Option<String> {
        self.phase.run().map(|run| run.cause.clone())
    }

    /// The turn's table: moves the phase on `event`, and returns what is
    /// left to do. The only writer of the phase.
    pub(crate) fn step(&mut self, event: TurnEvent) -> Vec<TurnEffect> {
        let phase = std::mem::replace(&mut self.phase, TurnPhase::Idle);
        let (next, effects) = match event {
            TurnEvent::PromptStarted(collector) => {
                let next = match phase {
                    TurnPhase::SelfWoken { run } | TurnPhase::CallerAndSelfWoken { run, .. } => {
                        TurnPhase::CallerAndSelfWoken { collector, run }
                    }
                    TurnPhase::Idle
                    | TurnPhase::Caller { .. }
                    | TurnPhase::CallerSettled { .. } => TurnPhase::Caller { collector },
                };
                (next, Vec::new())
            }
            TurnEvent::PromptEnded(ended) => {
                let next = match phase {
                    TurnPhase::Caller { collector } | TurnPhase::CallerSettled { collector }
                        if collector.same_channel(&ended) =>
                    {
                        TurnPhase::Idle
                    }
                    TurnPhase::CallerAndSelfWoken { collector, run }
                        if collector.same_channel(&ended) =>
                    {
                        TurnPhase::SelfWoken { run }
                    }
                    // Another prompt's end: the one being collected goes on.
                    // (Prompts take the turn lock one at a time, so this and
                    // a prompt starting over another are not reached today.)
                    other => other,
                };
                (next, Vec::new())
            }
            // The turn is the caller's, whoever opened it: reported as that
            // caller turn's start, so the application binds the prompt's
            // operation to it. A run joined as a `follow_up` sends no start
            // of its own; a turn opened for the prompt does, and a second
            // bind of one id changes nothing.
            TurnEvent::PromptReplied { turn_id } => {
                let effects = match phase.collector() {
                    Some(_) => vec![TurnEffect::Report(TurnBoundary::opened(
                        Some(turn_id),
                        "input".into(),
                    ))],
                    None => Vec::new(),
                };
                (phase, effects)
            }
            TurnEvent::Admitted {
                admitted: true,
                start,
                ..
            } => (phase.holding(SelfWokenRun::new(&start)), Vec::new()),
            // Refused, the start stays the caller's turn's.
            TurnEvent::Admitted {
                admitted: false,
                frame,
                ..
            } => {
                let effects = phase.forward(frame);
                (phase, effects)
            }
            TurnEvent::Event { seq, event } => Self::on_event(phase, seq, event),
            TurnEvent::Snapshot { seq, info } => Self::on_snapshot(phase, seq, info),
        };
        self.phase = next;
        effects
    }

    /// A session event from the host (`step`).
    fn on_event(phase: TurnPhase, seq: u64, event: Value) -> (TurnPhase, Vec<TurnEffect>) {
        let kind = event["kind"].as_str().unwrap_or_default().to_owned();
        let turn_id = event["turn_id"].as_str().map(str::to_owned);
        let cause = event["cause"].as_str().unwrap_or("unknown").to_owned();
        let text = event["text"].as_str().unwrap_or_default().to_owned();
        let frame = TurnFrame::Event { seq, event };
        match kind.as_str() {
            "turn_start" if matches!(cause.as_str(), "autonomous" | "unknown") => {
                let start = TurnBoundary::opened(turn_id, cause);
                match phase {
                    // The host opens a turn only once the one before it
                    // settled. So a self-woken start seen while a caller's
                    // prompt is collected either carries that prompt (it
                    // reached a session that had just woken itself), and the
                    // collector keeps it, or it follows the caller's turn
                    // straight away: a run resumed after an external abort,
                    // or a wake queued behind the turn. The application tells
                    // them apart: it admits the start only once the caller's
                    // operation has closed, which the host's settle report
                    // of that turn does (`settle_turn`).
                    TurnPhase::Caller { .. } | TurnPhase::CallerSettled { .. } => {
                        (phase, vec![TurnEffect::AskAdmission(start, frame)])
                    }
                    // With no prompt being collected, a self-woken start is
                    // no caller's turn: it is held whatever the application
                    // answers.
                    TurnPhase::Idle => {
                        let run = SelfWokenRun::new(&start);
                        (
                            TurnPhase::SelfWoken { run },
                            vec![TurnEffect::Report(start)],
                        )
                    }
                    // The host opens a turn only once the one before it has
                    // settled, so a second self-woken start means the held
                    // run is over: it ends with the words it kept, and the
                    // new run is held in its place, with the operation. A
                    // start that names the held run is that run's own.
                    TurnPhase::SelfWoken { .. } | TurnPhase::CallerAndSelfWoken { .. }
                        if phase
                            .run()
                            .is_some_and(|run| run.owns(start.turn_id.as_deref())) =>
                    {
                        (phase, Vec::new())
                    }
                    TurnPhase::SelfWoken { .. } | TurnPhase::CallerAndSelfWoken { .. } => {
                        phase.replacing(start)
                    }
                }
            }
            "turn_start" => {
                let mut effects = vec![TurnEffect::Report(TurnBoundary::opened(turn_id, cause))];
                effects.extend(phase.pass_on(frame));
                (phase, effects)
            }
            "text" => {
                let mut phase = phase;
                if let TurnPhase::SelfWoken { run } | TurnPhase::CallerAndSelfWoken { run, .. } =
                    &mut phase
                {
                    if run.owns(turn_id.as_deref()) {
                        run.append(&text);
                        // The run's words also reach a caller's prompt: one
                        // sent into the held run as a `follow_up` answers
                        // with them (#512). Any other prompt's `collect`
                        // passes them over, since they name another turn.
                        let effects = phase.forward(frame);
                        return (phase, effects);
                    }
                }
                let effects = phase.pass_on(frame);
                (phase, effects)
            }
            "turn_end" if phase.run().is_some_and(|run| run.owns(turn_id.as_deref())) => {
                // The end also reaches a caller's prompt: one sent into the
                // held run as a `follow_up` waits for exactly this end
                // (#512). Any other prompt's `collect` passes it over, since
                // it names another turn.
                let (next, mut effects) = phase.ending_run(RunEnding::Settled { last_text: "" });
                effects.extend(next.forward(frame));
                (next, effects)
            }
            "turn_end" if phase.run().is_some() => (phase, Vec::new()),
            "turn_end" => {
                // The caller's turn settled on the host. Its operation closes
                // on this report, not when the prompt returns, so a run the
                // host starts right behind it is admitted.
                let mut effects = phase.forward(frame);
                effects.extend(turn_id.map(|turn_id| {
                    TurnEffect::Report(TurnBoundary {
                        turn_id: Some(turn_id),
                        cause: "input".into(),
                        ended: true,
                        text: String::new(),
                        cut_short: false,
                    })
                }));
                (phase, effects)
            }
            "session_closed" => {
                // A closed session never sends the `turn_end` of a self-woken
                // run it had open, and that run's operation would keep every
                // later caller turn waiting: it ends here, cut short, and the
                // leg it spoke for is being retired.
                let (next, mut effects) = phase.ending_run(RunEnding::CutShort);
                effects.extend(next.forward(frame));
                (next, effects)
            }
            _ => {
                let effects = phase.pass_on(frame);
                (phase, effects)
            }
        }
    }

    /// A snapshot from the host (`step`). The host sends one after a
    /// restart or a replay it could not make, so the service may have
    /// missed the held run's `turn_end`: the snapshot says whether that run
    /// is still the turn open (#495).
    fn on_snapshot(phase: TurnPhase, seq: u64, info: Value) -> (TurnPhase, Vec<TurnEffect>) {
        let turn_id = info["turn_id"].as_str().map(str::to_owned);
        let open = || {
            TurnBoundary::opened(
                turn_id.clone(),
                info["cause"].as_str().unwrap_or("unknown").to_owned(),
            )
        };
        // An idle session has no turn open (its snapshot names none): the
        // held run settled, whatever its id, and the snapshot then goes to
        // the caller's prompt.
        if info["turn_open"] == false && phase.run().is_some() {
            let last_text = info["last_text"].as_str().unwrap_or_default().to_owned();
            let (next, mut effects) = phase.ending_run(RunEnding::Settled {
                last_text: &last_text,
            });
            effects.extend(next.forward(TurnFrame::Snapshot { seq, info }));
            return (next, effects);
        }
        // Another turn is open: the held run settled, and the open turn is
        // held in its place.
        if info["turn_open"] == true && phase.run().is_some_and(|run| !run.owns(turn_id.as_deref()))
        {
            let start = open();
            return phase.replacing(start);
        }
        // An open turn nobody holds or collects is a self-woken run.
        if info["turn_open"] == true && matches!(phase, TurnPhase::Idle) {
            let start = open();
            let run = SelfWokenRun::new(&start);
            return (
                TurnPhase::SelfWoken { run },
                vec![TurnEffect::Report(start)],
            );
        }
        let effects = phase.forward(TurnFrame::Snapshot { seq, info });
        (phase, effects)
    }
}

#[cfg(test)]
#[path = "../tests/test_session_turn.rs"]
mod tests;

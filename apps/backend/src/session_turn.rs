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

    /// The run's start, as it is reported once the run is the one held.
    fn start(&self) -> TurnBoundary {
        TurnBoundary::opened(self.turn_id.clone(), self.cause.clone())
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

    /// The run's end: its final text for the debug page, then its report.
    fn end(self, how: RunEnding) -> TurnEffect {
        let kept = self.text.join("\n").trim().to_owned();
        let (text, reported) = match how {
            RunEnding::Settled { last_text } if kept.is_empty() => (last_text.to_owned(), true),
            RunEnding::Settled { .. } => (kept, true),
            RunEnding::CutShort => (kept, false),
        };
        TurnEffect::RunEnded {
            report: TurnBoundary {
                turn_id: self.turn_id,
                cause: self.cause,
                ended: true,
                text: if reported {
                    text.clone()
                } else {
                    String::new()
                },
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

/// The self-woken run a session holds, and at most one queued behind it.
/// The host opens a turn only once the one before it settled, so a second
/// self-woken start while a run is held means that run's end was lost: the
/// second run keeps its own text behind it and runs when the held run ends,
/// or when its own end shows the held run is over (`docs/host-link.md`,
/// "A project session's turn").
struct HeldRuns {
    run: SelfWokenRun,
    queued: Option<SelfWokenRun>,
}

impl HeldRuns {
    fn new(run: SelfWokenRun) -> Self {
        Self { run, queued: None }
    }

    /// The text frame's run, the held one first.
    fn owner(&mut self, turn_id: Option<&str>) -> Option<&mut SelfWokenRun> {
        if self.run.owns(turn_id) {
            return Some(&mut self.run);
        }
        self.queued.as_mut().filter(|queued| queued.owns(turn_id))
    }

    /// Queues the self-woken run `start` opens behind the held one. Refused
    /// when one is queued already (the bound), or when `start` names the
    /// held run's own turn: a start with no id cannot be told from it.
    fn queue(&mut self, start: &TurnBoundary) -> bool {
        if self.queued.is_some() || self.run.owns(start.turn_id.as_deref()) {
            return false;
        }
        self.queued = Some(SelfWokenRun::new(start));
        true
    }

    fn queued_owns(&self, turn_id: Option<&str>) -> bool {
        self.queued
            .as_ref()
            .is_some_and(|queued| queued.owns(turn_id))
    }

    /// Whether `turn_id` is the held run's or the queued run's.
    fn names(&self, turn_id: Option<&str>) -> bool {
        self.run.owns(turn_id) || self.queued_owns(turn_id)
    }

    /// The held run ends. A run queued behind it is held next and reported
    /// started, unless the session closed under both: then it never started
    /// for the application, and goes with the session.
    fn end_held(self, how: RunEnding) -> (Option<HeldRuns>, Vec<TurnEffect>) {
        let promotes = matches!(how, RunEnding::Settled { .. });
        let mut effects = vec![self.run.end(how)];
        let next = self.queued.filter(|_| promotes).map(|queued| {
            effects.push(TurnEffect::Report(queued.start()));
            HeldRuns::new(queued)
        });
        (next, effects)
    }

    /// The queued run settled. The host settles turns in order, so the held
    /// run settled before it: both end, the held one first.
    fn end_queued(self, last_text: &str) -> Vec<TurnEffect> {
        let mut effects = vec![self.run.end(RunEnding::Settled { last_text: "" })];
        if let Some(queued) = self.queued {
            effects.push(TurnEffect::Report(queued.start()));
            effects.push(queued.end(RunEnding::Settled { last_text }));
        }
        effects
    }
}

/// A turn boundary as the pump reports it to the application
/// (`ProjectInner::report_turn` stamps it with the session).
pub(crate) struct TurnBoundary {
    pub(crate) turn_id: Option<String>,
    pub(crate) cause: String,
    pub(crate) ended: bool,
    pub(crate) text: String,
}

impl TurnBoundary {
    fn opened(turn_id: Option<String>, cause: String) -> Self {
        Self {
            turn_id,
            cause,
            ended: false,
            text: String::new(),
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
    /// A self-woken run is held (and perhaps one queued behind it): each
    /// keeps its own text, and no other turn's frame reaches anyone while
    /// one is held.
    SelfWoken { runs: HeldRuns },
    /// The application admitted a self-woken run while a caller's prompt was
    /// still being collected. It does so only once the caller's turn has
    /// settled on the host, so the run is behind that turn, and swallows its
    /// frames as it would alone.
    CallerAndSelfWoken {
        collector: Collector,
        runs: HeldRuns,
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

    fn runs(&self) -> Option<&HeldRuns> {
        match self {
            Self::SelfWoken { runs } | Self::CallerAndSelfWoken { runs, .. } => Some(runs),
            Self::Idle | Self::Caller { .. } | Self::CallerSettled { .. } => None,
        }
    }

    fn runs_mut(&mut self) -> Option<&mut HeldRuns> {
        match self {
            Self::SelfWoken { runs } | Self::CallerAndSelfWoken { runs, .. } => Some(runs),
            Self::Idle | Self::Caller { .. } | Self::CallerSettled { .. } => None,
        }
    }

    fn run(&self) -> Option<&SelfWokenRun> {
        self.runs().map(|runs| &runs.run)
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
            Self::Idle => Self::SelfWoken {
                runs: HeldRuns::new(run),
            },
            Self::Caller { collector } | Self::CallerSettled { collector } => {
                Self::CallerAndSelfWoken {
                    collector,
                    runs: HeldRuns::new(run),
                }
            }
            held @ (Self::SelfWoken { .. } | Self::CallerAndSelfWoken { .. }) => held,
        }
    }

    /// The phase with the runs held next, or without any.
    fn with_runs(collector: Option<Collector>, runs: Option<HeldRuns>) -> Self {
        match (collector, runs) {
            (None, None) => Self::Idle,
            (None, Some(runs)) => Self::SelfWoken { runs },
            (Some(collector), None) => Self::CallerSettled { collector },
            (Some(collector), Some(runs)) => Self::CallerAndSelfWoken { collector, runs },
        }
    }

    /// Ends some of the held runs with `end`, which returns what is held
    /// next; the phase keeps the caller's collector, if there is one.
    fn ending(
        self,
        end: impl FnOnce(HeldRuns) -> (Option<HeldRuns>, Vec<TurnEffect>),
    ) -> (Self, Vec<TurnEffect>) {
        let (collector, runs) = match self {
            Self::SelfWoken { runs } => (None, runs),
            Self::CallerAndSelfWoken { collector, runs } => (Some(collector), runs),
            other @ (Self::Idle | Self::Caller { .. } | Self::CallerSettled { .. }) => {
                return (other, Vec::new())
            }
        };
        let (next, effects) = end(runs);
        (Self::with_runs(collector, next), effects)
    }

    /// The phase after the held run ends (a run queued behind it is held
    /// next), and the run's end.
    fn ending_run(self, how: RunEnding) -> (Self, Vec<TurnEffect>) {
        self.ending(|runs| runs.end_held(how))
    }

    /// The phase after the queued run settled, which ends the held run too.
    fn ending_queued(self, last_text: &str) -> (Self, Vec<TurnEffect>) {
        self.ending(|runs| (None, runs.end_queued(last_text)))
    }
}

/// What moves a project session's turn.
pub(crate) enum TurnEvent {
    /// A caller's prompt is going out; its turn's frames go to `Collector`.
    PromptStarted(Collector),
    /// The prompt with this collector let go of it: it returned, or it was
    /// cancelled.
    PromptEnded(Collector),
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
    RunEnded {
        report: TurnBoundary,
        final_text: String,
    },
}

/// A project session's turn: its phase, and a self-woken start it refused.
pub(crate) struct TurnState {
    phase: TurnPhase,
    /// The turn id (empty for a legacy host's) of a self-woken start that
    /// came while a run was held and another queued behind it, and was
    /// refused. Its frames are dropped, the caller's prompt's included,
    /// until its `turn_end`, the next self-woken start the session takes, or
    /// an input's start.
    ignored: Option<String>,
}

impl TurnState {
    pub(crate) fn new() -> Self {
        Self {
            phase: TurnPhase::Idle,
            ignored: None,
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

    fn ignores(&self, turn_id: Option<&str>) -> bool {
        self.ignored
            .as_deref()
            .is_some_and(|ignored| ignored == turn_id.unwrap_or_default())
    }

    /// The turn's table: moves the phase on `event`, and returns what is
    /// left to do. The only writer of both fields.
    pub(crate) fn step(&mut self, event: TurnEvent) -> Vec<TurnEffect> {
        let phase = std::mem::replace(&mut self.phase, TurnPhase::Idle);
        let (next, effects) = match event {
            TurnEvent::PromptStarted(collector) => {
                let next = match phase {
                    TurnPhase::SelfWoken { runs } | TurnPhase::CallerAndSelfWoken { runs, .. } => {
                        TurnPhase::CallerAndSelfWoken { collector, runs }
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
                    TurnPhase::CallerAndSelfWoken { collector, runs }
                        if collector.same_channel(&ended) =>
                    {
                        TurnPhase::SelfWoken { runs }
                    }
                    // Another prompt's end: the one being collected goes on.
                    // (Prompts take the turn lock one at a time, so this and
                    // a prompt starting over another are not reached today.)
                    other => other,
                };
                (next, Vec::new())
            }
            TurnEvent::Admitted {
                admitted: true,
                start,
                ..
            } => {
                self.ignored = None;
                (phase.holding(SelfWokenRun::new(&start)), Vec::new())
            }
            // Refused, the start stays the caller's turn's.
            TurnEvent::Admitted {
                admitted: false,
                frame,
                ..
            } => {
                let effects = phase.forward(frame);
                (phase, effects)
            }
            TurnEvent::Event { seq, event } => self.on_event(phase, seq, event),
            TurnEvent::Snapshot { seq, info } => Self::on_snapshot(phase, seq, info),
        };
        self.phase = next;
        effects
    }

    /// A session event from the host (`step`).
    fn on_event(
        &mut self,
        phase: TurnPhase,
        seq: u64,
        event: Value,
    ) -> (TurnPhase, Vec<TurnEffect>) {
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
                        self.ignored = None;
                        let runs = HeldRuns::new(SelfWokenRun::new(&start));
                        (
                            TurnPhase::SelfWoken { runs },
                            vec![TurnEffect::Report(start)],
                        )
                    }
                    // A second self-woken start while a run is held waits
                    // behind it; one more while that one waits is refused,
                    // and its frames are dropped until its `turn_end`.
                    TurnPhase::SelfWoken { .. } | TurnPhase::CallerAndSelfWoken { .. } => {
                        let mut phase = phase;
                        let queued = phase.runs_mut().is_some_and(|runs| runs.queue(&start));
                        if !queued {
                            self.ignored = Some(start.turn_id.unwrap_or_default());
                        }
                        (phase, Vec::new())
                    }
                }
            }
            "turn_start" => {
                self.ignored = None;
                let mut effects = vec![TurnEffect::Report(TurnBoundary::opened(turn_id, cause))];
                effects.extend(phase.pass_on(frame));
                (phase, effects)
            }
            "text" if self.ignores(turn_id.as_deref()) => (phase, Vec::new()),
            "text" => {
                let mut phase = phase;
                if let Some(run) = phase
                    .runs_mut()
                    .and_then(|runs| runs.owner(turn_id.as_deref()))
                {
                    run.append(&text);
                    return (phase, Vec::new());
                }
                let effects = phase.pass_on(frame);
                (phase, effects)
            }
            "turn_end" if self.ignores(turn_id.as_deref()) => {
                self.ignored = None;
                (phase, Vec::new())
            }
            "turn_end" if phase.run().is_some_and(|run| run.owns(turn_id.as_deref())) => {
                phase.ending_run(RunEnding::Settled { last_text: "" })
            }
            "turn_end"
                if phase
                    .runs()
                    .is_some_and(|runs| runs.queued_owns(turn_id.as_deref())) =>
            {
                phase.ending_queued("")
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

    /// A snapshot from the host (`step`).
    fn on_snapshot(phase: TurnPhase, seq: u64, info: Value) -> (TurnPhase, Vec<TurnEffect>) {
        let turn_id = info["turn_id"].as_str();
        // An idle session settles the held run its snapshot names, and a run
        // queued behind it: an idle session has no turn open. The snapshot's
        // last text is the latest run's.
        let last_text = info["last_text"].as_str().unwrap_or_default();
        if info["turn_open"] == false {
            match phase.runs() {
                Some(runs) if runs.queued.is_some() && runs.names(turn_id) => {
                    return phase.ending_queued(last_text);
                }
                Some(runs) if runs.run.owns(turn_id) => {
                    return phase.ending_run(RunEnding::Settled { last_text });
                }
                _ => {}
            }
        }
        // An open turn nobody holds or collects is a self-woken run.
        if info["turn_open"] == true && matches!(phase, TurnPhase::Idle) {
            let start = TurnBoundary::opened(
                turn_id.map(str::to_owned),
                info["cause"].as_str().unwrap_or("unknown").to_owned(),
            );
            let runs = HeldRuns::new(SelfWokenRun::new(&start));
            return (
                TurnPhase::SelfWoken { runs },
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

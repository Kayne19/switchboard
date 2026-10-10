//! What the switchboard hands back for a caller's line: the text, the part of
//! it said aloud, the leg it came from, and any error. Every concern that
//! answers the caller builds its `Reply` here, so a failure is spoken the same
//! way whichever transition hit it, and its raw detail stays on the screen.
use crate::lifecycle::{Coordinator, LegIdentity};
use crate::pbx::Switchboard;
use crate::pi_client::Turn;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Utterance {
    pub text: String,
    pub synthesize: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Reply {
    pub text: String,
    pub route: String,
    pub route_label: String,
    pub error: Option<String>,
    pub to_speak: Vec<String>,
    /// Whether this reply contains text synthesized for the caller.
    pub voiced: bool,
    #[serde(skip)]
    pub(crate) delivery_generation: Option<u64>,
}

impl Reply {
    fn new(route: &str, label: &str, utterances: Vec<Utterance>, error: Option<String>) -> Self {
        let text = utterances
            .iter()
            .filter(|u| !u.text.is_empty())
            .map(|u| u.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let to_speak = utterances
            .iter()
            .filter(|u| u.synthesize && !u.text.is_empty())
            .map(|u| u.text.clone())
            .collect::<Vec<_>>();
        let voiced = !to_speak.is_empty();
        Self {
            text,
            route: route.into(),
            route_label: label.into(),
            error,
            to_speak,
            voiced,
            delivery_generation: None,
        }
    }
}

impl Switchboard {
    pub(crate) fn reply<I, S>(&self, texts: I, error: Option<String>) -> Reply
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        spoken_reply(&self.coordinator, texts, error)
    }

    /// A routing outage is a page error, not a sentence synthesized into the
    /// call. `speech.rs` turns this marker into `routing_unavailable`.
    pub(crate) fn routing_unavailable(&self) -> Reply {
        self.reply(
            std::iter::empty::<String>(),
            Some("routing_unavailable".into()),
        )
    }

    /// The reply to a turn of the leg the caller's operation runs on. It
    /// carries no generation of its own: it is delivered at the generation
    /// the operation was admitted at, so a rescue that lands while the turn
    /// runs makes it stale.
    pub(crate) fn reply_with_turn(&self, turn: Turn) -> Reply {
        let failed = turn.failed;
        let error = turn.error;
        let status = self.coordinator.status();
        Reply::new(
            &status.route,
            &status.label,
            vec![Utterance {
                text: turn.text,
                synthesize: false,
            }],
            failed.then_some(error),
        )
    }

    /// The reply to the first turn of a leg a transition committed (a
    /// transfer, a promotion, a takeover, a redial), delivered at the
    /// generation that leg was staged under. Never the generation current
    /// when the reply is built: a rescue that landed meanwhile owns that one.
    pub(crate) fn reply_with_turn_on(&self, turn: Turn, leg: &LegIdentity) -> Reply {
        let mut reply = self.reply_with_turn(turn);
        reply.delivery_generation = Some(leg.generation);
        reply
    }

    /// A failure said aloud in plain words. The raw `detail` goes only to
    /// the screen text and the reply's error; it is never spoken.
    pub(crate) fn reply_failure(&self, spoken: String, detail: impl Into<String>) -> Reply {
        failure_reply(&self.coordinator, spoken, detail.into())
    }

    /// Every way opening a project for the caller can fail says the same.
    pub(crate) fn couldnt_open(&self, project: &str, detail: impl Into<String>) -> Reply {
        self.reply_failure(format!("I couldn't open {project}."), detail)
    }

    /// Bringing work back from the background failed.
    pub(crate) fn couldnt_bring_back(&self, project: &str, detail: impl Into<String>) -> Reply {
        self.reply_failure(format!("I couldn't pick {project} back up."), detail)
    }

    /// A model change could not bring the project back up on the new model.
    pub(crate) fn couldnt_bring_up_on(
        &self,
        project: &str,
        spoken: &str,
        detail: impl Into<String>,
    ) -> Reply {
        self.reply_failure(
            format!("I couldn't bring {project} back up on {spoken}."),
            detail,
        )
    }

    /// Taking over a session open at the caller's desk failed.
    pub(crate) fn couldnt_take_over(&self, project: &str, detail: impl Into<String>) -> Reply {
        self.reply_failure(format!("I couldn't take over {project}."), detail)
    }

    /// The caller named a project the registry does not have.
    pub(crate) fn unknown_project_line(&self, spoken: &str) -> String {
        let known = self.registry.ids();
        if known.is_empty() {
            format!("I don't have a project called {spoken}, and none are set up yet.")
        } else {
            format!(
                "I don't have a project called {spoken}. The ones I have are {}.",
                known.join(", ")
            )
        }
    }

    pub(crate) fn reply_transfer_error(&self, message: String, error: Option<String>) -> Reply {
        let status = self.coordinator.status();
        Reply::new(
            &status.route,
            &status.label,
            vec![Utterance {
                text: message,
                synthesize: true,
            }],
            error,
        )
    }
}

/// A failure the switchboard says itself: `spoken` is read aloud, and the
/// raw `detail` is screen text and the reply's error, never speech.
pub(crate) fn failure_reply(coordinator: &Coordinator, spoken: String, detail: String) -> Reply {
    let status = coordinator.status();
    Reply::new(
        &status.route,
        &status.label,
        vec![
            Utterance {
                text: spoken,
                synthesize: true,
            },
            Utterance {
                text: detail.clone(),
                synthesize: false,
            },
        ],
        Some(detail),
    )
}

/// A reply the switchboard speaks itself, labelled with the leg the
/// coordinator names now.
pub(crate) fn spoken_reply<I, S>(
    coordinator: &Coordinator,
    texts: I,
    error: Option<String>,
) -> Reply
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let status = coordinator.status();
    Reply::new(
        &status.route,
        &status.label,
        texts
            .into_iter()
            .map(|text| Utterance {
                text: text.into(),
                synthesize: true,
            })
            .collect(),
        error,
    )
}

#[cfg(test)]
#[path = "../tests/test_reply.rs"]
mod tests;

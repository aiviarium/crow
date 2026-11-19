//! Budgets: what a person may use per UTC day, and the check that refuses a request once a limit is reached.
//! Pure: the router reads the limits and the day's usage and asks here.

use serde_json::json;
use time::{OffsetDateTime, Time};

use crate::sdk::{Error, Result};
use crate::types::{Limit, Task};

/// What a person may use per day; `None` is no limit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Limits {
    pub requests: Option<i64>,
    pub tokens: Option<i64>,
    pub audio_seconds: Option<i64>,
}

impl Limits {
    pub fn is_empty(&self) -> bool {
        *self == Limits::default()
    }
}

impl From<&Limit> for Limits {
    fn from(l: &Limit) -> Limits {
        Limits {
            requests: l.requests,
            tokens: l.tokens,
            audio_seconds: l.audio_seconds,
        }
    }
}

/// The limits that apply to a person: their own row, else the default's.
pub fn effective(own: Option<&Limit>, default: Option<&Limit>) -> Limits {
    own.or(default).map(Limits::from).unwrap_or_default()
}

/// What a person has used since the start of the day.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Used {
    pub requests: i64,
    /// Input and output tokens together.
    pub tokens: i64,
    pub audio_seconds: f64,
}

/// Midnight UTC of the day `now` is in.
pub fn start_of_day(now: OffsetDateTime) -> OffsetDateTime {
    now.to_offset(time::UtcOffset::UTC)
        .replace_time(Time::MIDNIGHT)
}

/// The start of the next day.
pub fn resets_at(now: OffsetDateTime) -> OffsetDateTime {
    start_of_day(now) + time::Duration::days(1)
}

/// `FORBIDDEN` with the limit in the details when a limit that applies to the task has been reached. A
/// transcription is held to the audio limit only, anything else to requests and tokens.
pub fn check(limits: &Limits, used: &Used, task: Task, now: OffsetDateTime) -> Result<()> {
    if limits.is_empty() {
        return Ok(());
    }
    let resets = resets_at(now)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let over = |what: &str, limit: i64, used: f64| {
        Error::forbidden(format!(
            "you have reached today's limit of {limit} {what} for model services; it resets at midnight UTC"
        ))
        .with_details(json!({ "limit": { what: limit }, "used": used, "resetsAt": resets }))
    };
    if let Some(l) = limits.requests
        && used.requests >= l
    {
        return Err(over("requests", l, used.requests as f64));
    }
    if task != Task::Transcription
        && let Some(l) = limits.tokens
        && used.tokens >= l
    {
        return Err(over("tokens", l, used.tokens as f64));
    }
    if task == Task::Transcription
        && let Some(l) = limits.audio_seconds
        && used.audio_seconds >= l as f64
    {
        return Err(over("audioSeconds", l, used.audio_seconds));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    fn limits(requests: Option<i64>, tokens: Option<i64>, audio: Option<i64>) -> Limits {
        Limits {
            requests,
            tokens,
            audio_seconds: audio,
        }
    }

    #[test]
    fn days_start_at_midnight_utc() {
        let t = datetime!(2026-11-14 22:31:00 +2);
        assert_eq!(start_of_day(t), datetime!(2026-11-14 00:00:00 UTC));
        let late = datetime!(2026-11-14 23:30:00 -3);
        assert_eq!(start_of_day(late), datetime!(2026-11-15 00:00:00 UTC));
        assert_eq!(resets_at(t), datetime!(2026-11-15 00:00:00 UTC));
    }

    #[test]
    fn no_limit_never_refuses() {
        let used = Used {
            requests: 1_000_000,
            tokens: 1_000_000_000,
            audio_seconds: 1e9,
        };
        assert!(
            check(
                &Limits::default(),
                &used,
                Task::Text,
                datetime!(2026-11-14 12:00 UTC)
            )
            .is_ok()
        );
    }

    #[test]
    fn a_reached_limit_refuses_with_the_limit_in_the_details() {
        let now = datetime!(2026-11-14 12:00 UTC);
        let l = limits(Some(10), None, None);
        let used = |requests| Used {
            requests,
            ..Default::default()
        };
        assert!(check(&l, &used(9), Task::Text, now).is_ok());
        let e = check(&l, &used(10), Task::Text, now).unwrap_err();
        assert_eq!(e.code(), "FORBIDDEN");
        let d = e.details().unwrap();
        assert_eq!(d["limit"]["requests"], 10);
        assert_eq!(d["used"], 10.0);
        assert_eq!(d["resetsAt"], "2026-11-15T00:00:00Z");
    }

    #[test]
    fn tokens_hold_text_tasks_and_audio_holds_transcription() {
        let now = datetime!(2026-11-14 12:00 UTC);
        let l = limits(None, Some(100), Some(60));
        let used = Used {
            requests: 3,
            tokens: 100,
            audio_seconds: 30.0,
        };
        assert!(check(&l, &used, Task::Text, now).is_err());
        assert!(check(&l, &used, Task::Fast, now).is_err());
        assert!(check(&l, &used, Task::Transcription, now).is_ok());
        let heard = Used {
            audio_seconds: 60.0,
            tokens: 0,
            ..used
        };
        assert!(check(&l, &heard, Task::Text, now).is_ok());
        let e = check(&l, &heard, Task::Transcription, now).unwrap_err();
        assert_eq!(e.details().unwrap()["limit"]["audioSeconds"], 60);
    }

    #[test]
    fn a_person_s_own_limits_replace_the_default() {
        let row = |user: &str, requests| Limit {
            id: String::new(),
            user: user.into(),
            requests,
            tokens: None,
            audio_seconds: None,
        };
        let default = row("default", Some(5));
        let own = row("u1", Some(500));
        assert_eq!(effective(Some(&own), Some(&default)).requests, Some(500));
        assert_eq!(effective(None, Some(&default)).requests, Some(5));
        assert!(effective(None, None).is_empty());
    }
}

//! Which mapping serves a task for a caller, and who may set which mapping. Pure: the router reads the rows,
//! the connections and the caller's rights, and asks here.
//!
//! - A person's own mapping comes first, then their space's, then the deployment's; a mapping whose
//!   connection the caller may not use, or whose provider is gone, is skipped.
//! - A deployment mapping needs an admin and a global connection. A space mapping needs `manage` on the space
//!   and a connection of that space. A person's mapping is their own, with a connection of their own.

use crate::sdk::{Error, Result};
use crate::types::{Mapping, MappingScope, MappingTask, Scope, Task};

/// Who is asking: the call's user, whether they are an admin, and the space the call is in (or names).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Caller<'a> {
    pub user: Option<&'a str>,
    pub admin: bool,
    pub space: Option<&'a str>,
}

pub fn task_of(t: MappingTask) -> Task {
    t
}

pub fn scope_of(s: MappingScope) -> Scope {
    s
}

/// The unique key of a mapping row: one per task at each scope (and space or person).
pub fn key(task: Task, scope: Scope, space: Option<&str>, user: Option<&str>) -> String {
    format!(
        "{}|{}|{}|{}",
        task.as_str(),
        scope.as_str(),
        space.unwrap_or(""),
        user.unwrap_or("")
    )
}

/// How early a scope is tried: the person's own, the space's, the deployment's.
fn rank(s: MappingScope) -> u8 {
    match s {
        MappingScope::User => 0,
        MappingScope::Space => 1,
        MappingScope::Global => 2,
    }
}

/// Whether a mapping is meant for the caller: the deployment's always, their space's, their own.
pub fn applies(m: &Mapping, caller: &Caller) -> bool {
    match m.scope {
        MappingScope::Global => true,
        MappingScope::Space => m.space.is_some() && m.space.as_deref() == caller.space,
        MappingScope::User => m.user.is_some() && m.user.as_deref() == caller.user,
    }
}

/// The mappings of `task` that can apply to the caller, in the order to try them.
pub fn candidates(rows: Vec<Mapping>, caller: &Caller, task: Task) -> Vec<Mapping> {
    let mut rows: Vec<Mapping> = rows
        .into_iter()
        .filter(|m| task_of(m.task) == task && applies(m, caller))
        .collect();
    rows.sort_by_key(|m| rank(m.scope));
    rows
}

/// Whether the caller may use the mapping's connection. A person with a role that sees every connection (an
/// admin) may; a call with no user (a plugin on its own) gets the deployment's mappings; anyone else needs
/// `use` on the connection (`allowed`).
pub fn usable(caller: &Caller, scope: MappingScope, allowed: bool) -> bool {
    caller.admin || (caller.user.is_none() && scope == MappingScope::Global) || allowed
}

/// Whether the caller sees a mapping in the list: admins all, others the deployment's, their own and their
/// space's when they may see the space.
pub fn visible(m: &Mapping, caller: &Caller, can_view_space: bool) -> bool {
    caller.admin
        || m.scope == MappingScope::Global
        || (m.scope == MappingScope::User && m.user.is_some() && m.user.as_deref() == caller.user)
        || (m.scope == MappingScope::Space && can_view_space && m.space.as_deref() == caller.space)
}

/// What the connection of a mapping to set is: its scope and who it belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnFacts<'a> {
    pub scope: Scope,
    pub space: Option<&'a str>,
    pub user: Option<&'a str>,
}

/// Who a mapping is for once the rules allow it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub space: Option<String>,
    pub user: Option<String>,
    /// The caller must have `manage` on this space before it is written.
    pub manage_space: Option<String>,
}

/// The rules for setting a mapping at `scope`: the target it writes, or why not.
pub fn target(scope: Scope, caller: &Caller, conn: Option<&ConnFacts>) -> Result<Target> {
    let none = |space: Option<String>, user: Option<String>, manage: Option<String>| Target {
        space,
        user,
        manage_space: manage,
    };
    match scope {
        Scope::Global => {
            if !caller.admin {
                return Err(Error::forbidden("only admins map tasks for the whole deployment"));
            }
            if conn.is_some_and(|c| c.scope != Scope::Global) {
                return Err(Error::invalid(
                    "a global mapping needs a global connection, which everyone may use",
                ));
            }
            Ok(none(None, None, None))
        }
        Scope::Space => {
            let space = caller
                .space
                .ok_or_else(|| Error::invalid("a space mapping needs a space"))?;
            if conn.is_some_and(|c| c.scope != Scope::Space || c.space != Some(space)) {
                return Err(Error::invalid(
                    "a space overrides a task only with a connection of its own",
                ));
            }
            Ok(none(Some(space.into()), None, Some(space.into())))
        }
        Scope::User => {
            let user = caller
                .user
                .ok_or_else(|| Error::forbidden("a user mapping needs a user"))?;
            if conn.is_some_and(|c| c.scope != Scope::User || c.user != Some(user)) {
                return Err(Error::invalid(
                    "a user overrides a task only with a connection of their own",
                ));
            }
            Ok(none(None, Some(user.into()), None))
        }
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    fn row(task: MappingTask, scope: MappingScope, space: Option<&str>, user: Option<&str>) -> Mapping {
        Mapping {
            id: String::new(),
            updated_at: datetime!(2026-11-14 12:00 UTC),
            key: key(task_of(task), scope_of(scope), space, user),
            task,
            scope,
            space: space.map(Into::into),
            user: user.map(Into::into),
            connection: format!("conn-{}", rank(scope)),
            model: "m".into(),
            live: None,
        }
    }

    fn ann<'a>() -> Caller<'a> {
        Caller {
            user: Some("ann"),
            admin: false,
            space: Some("s1"),
        }
    }

    #[test]
    fn a_persons_mapping_beats_their_spaces_and_the_deployments() {
        let rows = vec![
            row(MappingTask::Text, MappingScope::Global, None, None),
            row(MappingTask::Text, MappingScope::Space, Some("s1"), None),
            row(MappingTask::Text, MappingScope::User, None, Some("ann")),
            row(MappingTask::Text, MappingScope::User, None, Some("bob")),
            row(MappingTask::Text, MappingScope::Space, Some("s2"), None),
            row(MappingTask::Fast, MappingScope::User, None, Some("ann")),
        ];
        let got: Vec<_> = candidates(rows, &ann(), Task::Text)
            .into_iter()
            .map(|m| m.scope)
            .collect();
        assert_eq!(
            got,
            [MappingScope::User, MappingScope::Space, MappingScope::Global]
        );
    }

    #[test]
    fn a_call_without_a_space_or_user_gets_the_deployments_mapping_only() {
        let rows = vec![
            row(MappingTask::Text, MappingScope::Global, None, None),
            row(MappingTask::Text, MappingScope::Space, Some("s1"), None),
            row(MappingTask::Text, MappingScope::User, None, Some("ann")),
        ];
        let none = Caller::default();
        let got = candidates(rows, &none, Task::Text);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].scope, MappingScope::Global);
        assert!(usable(&none, MappingScope::Global, false));
        assert!(!usable(&ann(), MappingScope::Global, false));
        assert!(usable(&ann(), MappingScope::Global, true));
        assert!(usable(
            &Caller { admin: true, ..ann() },
            MappingScope::User,
            false
        ));
        assert!(!usable(&none, MappingScope::Space, false));
    }

    #[test]
    fn the_list_shows_what_the_caller_may_see() {
        let g = row(MappingTask::Text, MappingScope::Global, None, None);
        let s = row(MappingTask::Text, MappingScope::Space, Some("s1"), None);
        let other_space = row(MappingTask::Text, MappingScope::Space, Some("s2"), None);
        let mine = row(MappingTask::Text, MappingScope::User, None, Some("ann"));
        let theirs = row(MappingTask::Text, MappingScope::User, None, Some("bob"));
        let c = ann();
        assert!(visible(&g, &c, false));
        assert!(
            !visible(&s, &c, false),
            "a space the caller cannot view is not listed"
        );
        assert!(visible(&s, &c, true));
        assert!(!visible(&other_space, &c, true));
        assert!(visible(&mine, &c, false));
        assert!(!visible(&theirs, &c, false));
        let admin = Caller { admin: true, ..c };
        assert!(visible(&theirs, &admin, false) && visible(&other_space, &admin, false));
    }

    #[test]
    fn only_admins_map_a_task_for_everyone_and_with_a_global_connection() {
        let global = ConnFacts {
            scope: Scope::Global,
            space: None,
            user: None,
        };
        let e = target(Scope::Global, &ann(), Some(&global)).unwrap_err();
        assert_eq!(e.code(), "FORBIDDEN");
        let admin = Caller { admin: true, ..ann() };
        let t = target(Scope::Global, &admin, Some(&global)).unwrap();
        assert_eq!((t.space, t.user, t.manage_space), (None, None, None));
        let mine = ConnFacts {
            scope: Scope::User,
            space: None,
            user: Some("ann"),
        };
        assert_eq!(
            target(Scope::Global, &admin, Some(&mine)).unwrap_err().code(),
            "INVALID"
        );
    }

    #[test]
    fn a_space_mapping_needs_managing_the_space_and_a_connection_of_it() {
        let conn = ConnFacts {
            scope: Scope::Space,
            space: Some("s1"),
            user: None,
        };
        let t = target(Scope::Space, &ann(), Some(&conn)).unwrap();
        assert_eq!(t.space.as_deref(), Some("s1"));
        assert_eq!(t.manage_space.as_deref(), Some("s1"));
        let elsewhere = ConnFacts {
            space: Some("s2"),
            ..conn
        };
        assert_eq!(
            target(Scope::Space, &ann(), Some(&elsewhere)).unwrap_err().code(),
            "INVALID"
        );
        let nowhere = Caller { space: None, ..ann() };
        assert_eq!(
            target(Scope::Space, &nowhere, Some(&conn)).unwrap_err().code(),
            "INVALID"
        );
    }

    #[test]
    fn a_persons_mapping_is_their_own_with_their_own_connection() {
        let mine = ConnFacts {
            scope: Scope::User,
            space: None,
            user: Some("ann"),
        };
        let t = target(Scope::User, &ann(), Some(&mine)).unwrap();
        assert_eq!(t.user.as_deref(), Some("ann"));
        let bobs = ConnFacts {
            user: Some("bob"),
            ..mine
        };
        assert_eq!(
            target(Scope::User, &ann(), Some(&bobs)).unwrap_err().code(),
            "INVALID"
        );
        let nobody = Caller::default();
        assert_eq!(
            target(Scope::User, &nobody, Some(&mine)).unwrap_err().code(),
            "FORBIDDEN"
        );
    }

    #[test]
    fn keys_tell_the_scopes_apart() {
        assert_ne!(
            key(Task::Text, Scope::User, None, Some("a")),
            key(Task::Text, Scope::User, None, Some("b"))
        );
        assert_ne!(
            key(Task::Text, Scope::Global, None, None),
            key(Task::Fast, Scope::Global, None, None)
        );
    }
}

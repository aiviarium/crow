//! A connection as the router reads it.

use std::fmt;

use serde_json::{Map, Value};

use crate::rules::ConnFacts;
use crate::sdk::{ConnectionResolved, FacilityScope};
use crate::types::Scope;

#[derive(Clone, PartialEq)]
pub struct Conn {
    pub id: String,
    pub uri: String,
    pub kind: String,
    pub name: String,
    pub scope: Scope,
    pub space: Option<String>,
    pub user: Option<String>,
    /// Connection fields plus sealed credential (`apiKey`) when resolved. Redacted in Debug output.
    pub values: Map<String, Value>,
}

impl fmt::Debug for Conn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Conn")
            .field("id", &self.id)
            .field("uri", &self.uri)
            .field("kind", &self.kind)
            .field("name", &self.name)
            .field("scope", &self.scope)
            .field("space", &self.space)
            .field("user", &self.user)
            .field("has_api_key", &self.values.contains_key("apiKey"))
            .finish()
    }
}

impl Conn {
    pub fn from_resolved(resolved: ConnectionResolved, caller_user: Option<&str>) -> Self {
        let c = resolved.connection;
        let scope = match c.scope {
            FacilityScope::User => Scope::User,
            FacilityScope::Global => Scope::Global,
            FacilityScope::Space => Scope::Space,
        };
        let space = if scope == Scope::Space {
            c.space_id.clone()
        } else {
            None
        };
        let mut values = c.config.as_object().cloned().unwrap_or_default();
        if let Some(cred) = resolved.credential.filter(|s| !s.is_empty()) {
            values.insert("apiKey".into(), Value::String(cred));
        }
        let user = if scope == Scope::User {
            caller_user.map(str::to_string)
        } else {
            None
        };
        Self {
            uri: format!("connection://{}", c.id),
            id: c.id,
            kind: c.kind,
            name: c.name,
            scope,
            space,
            user,
            values,
        }
    }

    pub fn facts(&self) -> ConnFacts<'_> {
        ConnFacts {
            scope: self.scope,
            space: self.space.as_deref(),
            user: self.user.as_deref(),
        }
    }

    /// Public non-secret configuration fields for destination computation and display.
    pub fn config(&self) -> Map<String, Value> {
        let mut cfg = self.values.clone();
        cfg.remove("apiKey");
        cfg
    }
}

#[cfg(test)]
mod tests {
    use rookery_proto::facilities::ConnectionInfo;
    use serde_json::json;

    use super::*;

    #[test]
    fn resolved_connection_keeps_credential_only_in_values_and_redacts_debug() {
        let resolved = ConnectionResolved {
            connection: ConnectionInfo {
                id: "c1".into(),
                kind: "ai.openai-compatible".into(),
                name: "OpenAI".into(),
                scope: FacilityScope::User,
                config: json!({ "baseUrl": "https://api.openai.com/v1" }),
                has_credential: true,
                space_id: None,
                updated_at: "2026-11-14T12:00:00Z".into(),
            },
            credential: Some("sk-secret-value".into()),
        };
        let conn = Conn::from_resolved(resolved, Some("u1"));
        assert_eq!(conn.scope, Scope::User);
        assert_eq!(conn.user.as_deref(), Some("u1"));
        assert_eq!(
            conn.values.get("apiKey").and_then(Value::as_str),
            Some("sk-secret-value")
        );
        assert!(!conn.config().contains_key("apiKey"));
        let dbg = format!("{conn:?}");
        assert!(!dbg.contains("sk-secret-value"));
    }
}

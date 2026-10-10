//! `/api/admin/*` on this server, behind the `ADMIN_TOKEN` bearer secret (404 without it):
//!
//! - `POST /api/admin/import[?force=1]`: imports an export file (the cutover's path; see docs/cutover.md)
//! - `POST /api/admin/export`: every record, in the same format
//! - `POST /api/admin/stats`: counts for checking a cutover

use std::sync::Arc;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use hyper::{Response, StatusCode};
use serde_json::json;

use crate::http::{Admin, App, Body, json_response, response};
use crate::migration::{self, ExportFile};

pub struct TokenAdmin {
    pub token_hash: String,
}

impl Admin for TokenAdmin {
    fn authorized(&self, token: &str) -> bool {
        !token.is_empty() && crate::crypto::token_matches(token, &self.token_hash)
    }

    fn handle(&self, app: Arc<App>, path: String, body: Bytes) -> BoxFuture<'static, Response<Body>> {
        async move {
            let service = &app.service;
            let (path, query) = path.split_once('?').unwrap_or((&path, ""));
            match path {
                "import" => {
                    let file: ExportFile = match serde_json::from_slice(&body) {
                        Ok(file) => file,
                        Err(error) => {
                            return json_response(
                                StatusCode::BAD_REQUEST,
                                &json!({ "error": error.to_string() }),
                            );
                        }
                    };
                    let force = query.split('&').any(|pair| pair == "force=1");
                    match migration::import(&service.store, &service.clock, file, force).await {
                        Ok(summary) => {
                            for id in &summary.ids {
                                service.invalidate(id).await;
                            }
                            json_response(StatusCode::OK, &summary)
                        }
                        Err(error) => json_response(
                            StatusCode::BAD_REQUEST,
                            &json!({ "error": format!("{error:#}") }),
                        ),
                    }
                }
                "export" => match migration::export(&service.store, &service.clock).await {
                    Ok(file) => json_response(StatusCode::OK, &file),
                    Err(error) => json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &json!({ "error": format!("{error:#}") }),
                    ),
                },
                "stats" => match service.store.counts().await {
                    Ok(mut counts) => {
                        counts["bridges_attached"] = service.bridge_count().into();
                        counts["legacy_forwarded"] =
                            app.stats.legacy_forwarded.load(Ordering::Relaxed).into();
                        counts["tunnel_connections"] =
                            app.stats.tunnel_connections.load(Ordering::Relaxed).into();
                        json_response(StatusCode::OK, &counts)
                    }
                    Err(error) => json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &json!({ "error": format!("{error:#}") }),
                    ),
                },
                _ => response(StatusCode::NOT_FOUND),
            }
        }
        .boxed()
    }
}

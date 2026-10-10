//! `/api/admin/*` on this server, behind the `ADMIN_TOKEN` bearer secret (404 without it):
//!
//! - `POST /api/admin/import[?force=1]`: imports an export file (the cutover's path; see docs/cutover.md)
//! - `POST /api/admin/export`: every record, in the same format
//! - `POST /api/admin/stats`: counts for checking a cutover, this machine's counters, and every machine's bridges

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

    fn handle(
        &self,
        app: Arc<App>,
        path: String,
        body: Bytes,
    ) -> BoxFuture<'static, Response<Body>> {
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
                        // This machine's counters (top level, as before, and under `machine`).
                        let stats = &app.stats;
                        counts["bridges_attached"] = service.bridge_count().into();
                        counts["legacy_forwarded"] =
                            stats.legacy_forwarded.load(Ordering::Relaxed).into();
                        counts["tunnel_connections"] =
                            stats.tunnel_connections.load(Ordering::Relaxed).into();
                        if let Some(cluster) = service.cluster() {
                            counts["machine"] = json!({
                                "id": cluster.machine_id,
                                "region": cluster.region,
                                "address": cluster.address(),
                                "bridges_attached": service.bridge_count(),
                                "tunnel_connections": stats.tunnel_connections.load(Ordering::Relaxed),
                                "forwarded_out": stats.forwarded_out.load(Ordering::Relaxed),
                                "forwarded_in": stats.forwarded_in.load(Ordering::Relaxed),
                                "forward_failures": stats.forward_failures.load(Ordering::Relaxed),
                                "legacy_forwarded": stats.legacy_forwarded.load(Ordering::Relaxed),
                                // Grows with open connections and bridges only; anything else is a leak.
                                "tasks": tokio::runtime::Handle::current().metrics().num_alive_tasks(),
                            });
                            // Every machine, from the registry.
                            counts["cluster"] = match cluster.machines().await {
                                Ok(machines) => {
                                    let mut regions = serde_json::Map::new();
                                    for machine in &machines {
                                        let bridges = regions
                                            .get(&machine.region)
                                            .and_then(serde_json::Value::as_u64)
                                            .unwrap_or(0);
                                        regions.insert(
                                            machine.region.clone(),
                                            (bridges + machine.bridges).into(),
                                        );
                                    }
                                    json!({
                                        "bridges": machines.iter().map(|machine| machine.bridges).sum::<u64>(),
                                        "regions": regions,
                                        "machines": machines,
                                    })
                                }
                                Err(error) => json!({ "error": format!("{error:#}") }),
                            };
                        }
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

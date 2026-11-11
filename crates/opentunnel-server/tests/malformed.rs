//! Malformed bridge control messages close the bridge cleanly instead of panicking (#51).

mod common;

use common::TestServer;
use futures_util::{SinkExt, StreamExt};
use opentunnel::protocol::bridge::{
    ClientInfo, ClientMessage, ServerMessage, Transport, WEBSOCKET_SUBPROTOCOL,
};
use opentunnel::{Client, ClientOptions, Storage};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open(server: &TestServer, id: &str) -> Socket {
    let url = format!(
        "{}/api/tunnel/{id}/connect",
        server.api.replace("http://", "ws://")
    );
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

/// What the server answered before closing: a close frame's reason, or an attach error code.
async fn outcome(socket: &mut Socket) -> String {
    while let Some(message) = socket.next().await {
        match message {
            Ok(Message::Close(Some(frame))) => {
                return format!("{} {}", u16::from(frame.code), frame.reason);
            }
            Ok(Message::Close(None)) | Err(_) => return "closed".into(),
            Ok(Message::Text(text)) => {
                if let Ok(Some(ServerMessage::AttachError { code })) = ServerMessage::decode(&text)
                {
                    return format!("attach_error {code}");
                }
            }
            Ok(_) => {}
        }
    }
    "closed".into()
}

async fn attached(server: &TestServer, id: &str, token: &str) -> Socket {
    let mut socket = open(server, id).await;
    let attach = ClientMessage::Attach {
        token: token.to_owned(),
        transport: Transport::Ws,
        routes: vec!["@".into()],
        client: ClientInfo {
            version: "test".into(),
            max_conns: 100,
        },
    };
    socket
        .send(Message::text(serde_json::to_string(&attach).unwrap()))
        .await
        .unwrap();
    loop {
        let Some(Ok(Message::Text(text))) = socket.next().await else {
            panic!("bridge closed before attach");
        };
        if let Ok(Some(ServerMessage::Attached { .. })) = ServerMessage::decode(&text) {
            return socket;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_control_messages_close_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let Some(server) = TestServer::start(dir.path(), &[]).await else {
        return;
    };
    let client = Client::new(ClientOptions {
        api: Some(server.api.parse().unwrap()),
        storage: Some(Storage::at(dir.path().join("client"))),
        ..Default::default()
    });
    let identity = client.create("default", |_| {}).await.unwrap();

    for (payload, expected) in [
        ("{}", "1008 invalid control"),
        (r#"{"type": 123}"#, "1008 invalid control"),
        (r#"{"foo": "bar"}"#, "1008 invalid control"),
        ("[]", "1008 invalid control"),
        ("not json", "1008 invalid control"),
        (r#"{"type": "ping"}"#, "1008 attach required"),
        (r#"{"type": "end"}"#, "1008 attach required"),
        (r#"{"type": "attach"}"#, "1008 attach required"),
        (
            r#"{"type": "attach", "token": "bad"}"#,
            "attach_error bad_token",
        ),
    ] {
        let mut socket = open(&server, &identity.id).await;
        socket.send(Message::text(payload)).await.unwrap();
        // Before the fix, the server's task panicked and the socket was left open: time out instead of hanging.
        let answer = tokio::time::timeout(std::time::Duration::from_secs(10), outcome(&mut socket))
            .await
            .unwrap_or_else(|_| "no answer within 10 s".into());
        assert_eq!(answer, expected, "payload {payload}");
    }

    // Bridges dropped right after a malformed first message, without a close, are all reclaimed.
    for payload in ["{}", r#"{"type": "attach"}"#, r#"{"type": "ping"}"#] {
        for _ in 0..5 {
            let mut socket = open(&server, &identity.id).await;
            socket.send(Message::text(payload)).await.unwrap();
            drop(socket);
        }
    }
    common::eventually("abandoned bridges to be reclaimed", || async {
        server.service().registered_bridges().await == 0
    })
    .await;

    // After attaching, control messages missing their fields are ignored, and the bridge keeps working.
    let mut socket = attached(&server, &identity.id, &identity.token).await;
    for payload in [
        r#"{"type": "ping"}"#,
        r#"{"type": "end"}"#,
        r#"{"type": "reset"}"#,
    ] {
        socket.send(Message::text(payload)).await.unwrap();
    }
    let ping = ClientMessage::Ping { time_sent: 42 };
    socket
        .send(Message::text(serde_json::to_string(&ping).unwrap()))
        .await
        .unwrap();
    loop {
        let Some(Ok(message)) = socket.next().await else {
            panic!("bridge closed after malformed control messages");
        };
        if let Message::Text(text) = message
            && let Ok(Some(ServerMessage::Pong { .. })) = ServerMessage::decode(&text)
        {
            break;
        }
    }
}

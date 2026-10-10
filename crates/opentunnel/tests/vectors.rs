use opentunnel::protocol::bridge::{decode_data_frame, encode_data_frame};
use opentunnel::protocol::names::{is_valid_profile, is_valid_route, parse_target, route_for_sni};
use opentunnel::protocol::proxy::{ProxyProtocol, header, parse_peer};
use opentunnel::protocol::routes::Route;
use opentunnel::protocol::{ClientMessage, ServerMessage};
use serde_json::Value;

fn vector(name: &str) -> Value {
    let path = format!("{}/../../spec/vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn control_messages() {
    let control = vector("control.json");
    for value in control["client"].as_array().unwrap() {
        let message: ClientMessage = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(&serde_json::to_value(&message).unwrap(), value);
    }
    for value in control["server"].as_array().unwrap() {
        let message = ServerMessage::decode(&value.to_string()).unwrap().unwrap();
        assert_eq!(&serde_json::to_value(&message).unwrap(), value);
    }
    for value in control["ignored"].as_array().unwrap() {
        assert!(ServerMessage::decode(&value.to_string()).unwrap().is_none());
    }
    for value in control["invalid"].as_array().unwrap() {
        assert!(
            ServerMessage::decode(&value.to_string()).is_err(),
            "{value}"
        );
    }
}

#[test]
fn data_frames() {
    for case in vector("frames.json").as_array().unwrap() {
        let conn = case["conn"].as_u64().unwrap() as u32;
        let payload = hex::decode(case["payload"].as_str().unwrap()).unwrap();
        let frame = hex::decode(case["frame"].as_str().unwrap()).unwrap();
        assert_eq!(encode_data_frame(conn, &payload), frame);
        assert_eq!(decode_data_frame(&frame), Some((conn, payload.as_slice())));
    }
    assert_eq!(decode_data_frame(&[0, 0, 1]), None);
}

#[test]
fn routes() {
    for case in vector("routes.json").as_array().unwrap() {
        let route = route_for_sni(
            case["sni"].as_str().unwrap(),
            case["hostname"].as_str().unwrap(),
        );
        assert_eq!(route.as_deref(), case["route"].as_str(), "{case}");
    }
}

#[test]
fn names() {
    let names = vector("names.json");
    let check = |key: &str, valid: fn(&str) -> bool| {
        for case in names[key].as_array().unwrap() {
            let value = case["value"].as_str().unwrap();
            assert_eq!(
                valid(value),
                case["valid"].as_bool().unwrap(),
                "{key}: {value}"
            );
        }
    };
    check("route", is_valid_route);
    check("profile", is_valid_profile);
    check("target", |value| parse_target(value).is_some());
}

#[test]
fn proxy_protocol_peers() {
    for case in vector("proxy-protocol.json")["peers"].as_array().unwrap() {
        let parsed = parse_peer(case["peer"].as_str().unwrap());
        let expected = case["address"]
            .as_str()
            .map(|address| (address.to_owned(), case["port"].as_u64().unwrap() as u16));
        assert_eq!(
            parsed.map(|address| (address.ip().to_string(), address.port())),
            expected,
            "{case}"
        );
    }
}

#[test]
fn proxy_protocol_headers() {
    for case in vector("proxy-protocol.json")["headers"].as_array().unwrap() {
        let version = ProxyProtocol::parse(case["version"].as_str().unwrap()).unwrap();
        let encoded = header(
            version,
            case["peer"].as_str().unwrap(),
            case["sni"].as_str().unwrap(),
        );
        assert_eq!(
            hex::encode(&encoded),
            case["header"].as_str().unwrap(),
            "{case}"
        );
        if let Some(text) = case["text"].as_str() {
            assert_eq!(String::from_utf8(encoded).unwrap(), text);
        }
    }
}

#[test]
fn route_options() {
    for case in vector("route-options.json")["routes"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let parsed = serde_json::from_value::<Route>(case["profile"].clone())
            .map_err(|error| error.to_string())
            .and_then(|route| route.validate(name).map(|()| route));
        if case["error"].as_bool() == Some(true) {
            assert!(parsed.is_err(), "{case}");
            continue;
        }
        let route = parsed.unwrap_or_else(|error| panic!("{case}: {error}"));
        assert_eq!(route.target, case["route"]["target"].as_str().unwrap());
        assert_eq!(
            route.proxy_protocol.map(ProxyProtocol::as_str),
            case["route"]["proxyProtocol"].as_str()
        );
        assert_eq!(
            serde_json::to_value(&route).unwrap(),
            case["written"],
            "{case}"
        );
    }
}

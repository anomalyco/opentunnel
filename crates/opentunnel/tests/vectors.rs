use opentunnel::protocol::bridge::{decode_data_frame, encode_data_frame};
use opentunnel::protocol::names::{is_valid_profile, is_valid_route, parse_target, route_for_sni};
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

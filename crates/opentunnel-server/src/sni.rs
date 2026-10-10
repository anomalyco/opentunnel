//! Reads the server name and ALPN from a TLS ClientHello without terminating TLS.

/// Bytes read while looking for a complete ClientHello before giving up.
pub const CLIENT_HELLO_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hello {
    /// More bytes are needed.
    Incomplete,
    Invalid(&'static str),
    Complete {
        /// Lowercased.
        server_name: String,
        /// The first protocol offered, or empty.
        alpn: String,
    },
}

fn u16_at(data: &[u8], offset: usize) -> usize {
    ((data[offset] as usize) << 8) | data[offset + 1] as usize
}

/// Parses the TLS records at the start of a connection, which may split the ClientHello across records.
pub fn parse_client_hello(data: &[u8]) -> Hello {
    let mut handshake: Vec<u8> = Vec::new();
    let mut record_offset = 0;
    let mut handshake_length: Option<usize> = None;

    while record_offset < data.len() {
        if data.len() - record_offset < 5 {
            return Hello::Incomplete;
        }
        if data[record_offset] != 0x16 {
            return Hello::Invalid("expected TLS handshake record");
        }
        let record_length = u16_at(data, record_offset + 3);
        if data.len() - record_offset - 5 < record_length {
            return Hello::Incomplete;
        }
        let start = record_offset + 5;
        handshake.extend_from_slice(&data[start..start + record_length]);
        record_offset = start + record_length;

        if handshake.len() >= 4 {
            if handshake[0] != 0x01 {
                return Hello::Invalid("expected TLS ClientHello");
            }
            let length = *handshake_length.get_or_insert(
                ((handshake[1] as usize) << 16)
                    | ((handshake[2] as usize) << 8)
                    | handshake[3] as usize,
            );
            if handshake.len() >= length + 4 {
                break;
            }
        }
    }

    let Some(length) = handshake_length else {
        return Hello::Incomplete;
    };
    if handshake.len() < length + 4 {
        return Hello::Incomplete;
    }
    let hello = &handshake[4..length + 4];
    parse_hello_body(hello)
}

fn parse_hello_body(hello: &[u8]) -> Hello {
    if hello.len() < 35 {
        return Hello::Invalid("truncated ClientHello");
    }
    let mut offset = 2 + 32;
    let session_length = hello[offset] as usize;
    offset += 1 + session_length;
    if offset + 2 > hello.len() {
        return Hello::Invalid("invalid session");
    }
    let cipher_length = u16_at(hello, offset);
    offset += 2 + cipher_length;
    if offset >= hello.len() {
        return Hello::Invalid("invalid cipher suites");
    }
    let compression_length = hello[offset] as usize;
    offset += 1 + compression_length;
    if offset == hello.len() {
        return Hello::Invalid("ClientHello has no SNI");
    }
    if offset + 2 > hello.len() {
        return Hello::Invalid("invalid extensions");
    }
    let extensions_length = u16_at(hello, offset);
    offset += 2;
    let extensions_end = offset + extensions_length;
    if extensions_end > hello.len() {
        return Hello::Invalid("truncated extensions");
    }

    let mut server_name = String::new();
    let mut alpn = String::new();
    while offset + 4 <= extensions_end {
        let kind = u16_at(hello, offset);
        let length = u16_at(hello, offset + 2);
        offset += 4;
        let end = offset + length;
        if end > extensions_end {
            return Hello::Invalid("truncated extension");
        }
        if kind == 0 && length >= 5 {
            let list_end = end.min(offset + 2 + u16_at(hello, offset));
            let mut name_offset = offset + 2;
            while name_offset + 3 <= list_end {
                let name_type = hello[name_offset];
                let name_length = u16_at(hello, name_offset + 1);
                name_offset += 3;
                if name_offset + name_length > list_end {
                    break;
                }
                if name_type == 0 {
                    server_name =
                        String::from_utf8_lossy(&hello[name_offset..name_offset + name_length])
                            .into_owned();
                    break;
                }
                name_offset += name_length;
            }
        } else if kind == 16 && length >= 3 {
            let list_end = end.min(offset + 2 + u16_at(hello, offset));
            let protocol_length = hello[offset + 2] as usize;
            if offset + 3 + protocol_length <= list_end {
                alpn = String::from_utf8_lossy(&hello[offset + 3..offset + 3 + protocol_length])
                    .into_owned();
            }
        }
        offset = end;
    }

    if server_name.is_empty() {
        return Hello::Invalid("ClientHello has no SNI");
    }
    Hello::Complete {
        server_name: server_name.to_lowercase(),
        alpn,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn u16be(n: usize) -> [u8; 2] {
        [(n >> 8) as u8, n as u8]
    }

    /// A minimal ClientHello naming `sni` and offering `alpn`, in one TLS record.
    pub(crate) fn client_hello(sni: &str, alpn: &[&str]) -> Vec<u8> {
        let mut extensions = Vec::new();
        let name = sni.as_bytes();
        let mut names = vec![0u8];
        names.extend(u16be(name.len()));
        names.extend(name);
        let mut list = u16be(names.len()).to_vec();
        list.extend(names);
        extensions.extend([0, 0]);
        extensions.extend(u16be(list.len()));
        extensions.extend(list);
        if !alpn.is_empty() {
            let mut protocols = Vec::new();
            for protocol in alpn {
                protocols.push(protocol.len() as u8);
                protocols.extend(protocol.as_bytes());
            }
            let mut body = u16be(protocols.len()).to_vec();
            body.extend(protocols);
            extensions.extend([0, 16]);
            extensions.extend(u16be(body.len()));
            extensions.extend(body);
        }
        let mut hello = vec![3, 3];
        hello.extend([0u8; 32]);
        hello.extend([0, 0, 2, 0x13, 1, 1, 0]);
        hello.extend(u16be(extensions.len()));
        hello.extend(extensions);
        let mut handshake = vec![1, 0];
        handshake.extend(u16be(hello.len()));
        handshake.extend(hello);
        let mut record = vec![0x16, 3, 1];
        record.extend(u16be(handshake.len()));
        record.extend(handshake);
        record
    }

    #[test]
    fn reads_sni_and_alpn() {
        let hello = client_hello("API.Example.Test", &["h2", "http/1.1"]);
        assert_eq!(
            parse_client_hello(&hello),
            Hello::Complete {
                server_name: "api.example.test".into(),
                alpn: "h2".into()
            }
        );
    }

    #[test]
    fn waits_for_more_bytes() {
        let hello = client_hello("example.test", &[]);
        for cut in [0, 3, 5, hello.len() - 1] {
            assert_eq!(
                parse_client_hello(&hello[..cut]),
                Hello::Incomplete,
                "cut {cut}"
            );
        }
    }

    #[test]
    fn handles_a_hello_split_across_records() {
        let hello = client_hello("split.example.test", &["http/1.1"]);
        let handshake = &hello[5..];
        let (first, second) = handshake.split_at(20);
        let mut data = vec![0x16, 3, 1, 0, first.len() as u8];
        data.extend(first);
        data.extend([0x16, 3, 1]);
        data.extend(u16be(second.len()));
        data.extend(second);
        assert_eq!(
            parse_client_hello(&data),
            Hello::Complete {
                server_name: "split.example.test".into(),
                alpn: "http/1.1".into()
            }
        );
    }

    #[test]
    fn rejects_non_tls_and_missing_sni() {
        assert_eq!(
            parse_client_hello(b"GET / HTTP/1.1\r\n\r\n"),
            Hello::Invalid("expected TLS handshake record")
        );
        let mut hello = vec![3, 3];
        hello.extend([0u8; 32]);
        hello.extend([0, 0, 2, 0x13, 1, 1, 0]);
        let mut handshake = vec![1, 0];
        handshake.extend(u16be(hello.len()));
        handshake.extend(hello);
        let mut record = vec![0x16, 3, 1];
        record.extend(u16be(handshake.len()));
        record.extend(handshake);
        assert_eq!(
            parse_client_hello(&record),
            Hello::Invalid("ClientHello has no SNI")
        );
    }

    #[test]
    fn rejects_other_handshake_messages() {
        let mut hello = client_hello("example.test", &[]);
        hello[5] = 2;
        assert_eq!(
            parse_client_hello(&hello),
            Hello::Invalid("expected TLS ClientHello")
        );
    }

    #[test]
    fn never_panics_on_garbage() {
        let hello = client_hello("fuzz.example.test", &["h2"]);
        for index in 5..hello.len() {
            for value in [0u8, 1, 0x7f, 0xff] {
                let mut mutated = hello.clone();
                mutated[index] = value;
                let _ = parse_client_hello(&mutated);
                let _ = parse_client_hello(&mutated[..index]);
            }
        }
    }
}

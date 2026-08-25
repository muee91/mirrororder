use serde_json::Value;
use std::{
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    time::Duration,
};

const MAX_RESPONSE_BYTES: usize = 16 * 1024;

pub fn probe_service(port: u16, expected_service: &str, timeout: Duration) -> Result<(), String> {
    probe_service_at(IpAddr::from([127, 0, 0, 1]), port, expected_service, timeout)
}

pub fn probe_service_at(
    ip: IpAddr,
    port: u16,
    expected_service: &str,
    timeout: Duration,
) -> Result<(), String> {
    let address = SocketAddr::new(ip, port);
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("无法连接 {address}：{error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("无法设置健康检查读取超时：{error}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("无法设置健康检查写入超时：{error}"))?;

    let request = format!(
        "GET /api/v1/ping HTTP/1.1\r\nHost: {address}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("健康检查请求失败：{error}"))?;

    let mut response = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 2048];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(size) => {
                if response.len() + size > MAX_RESPONSE_BYTES {
                    return Err("健康检查响应过大".to_string());
                }
                response.extend_from_slice(&chunk[..size]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock || error.kind() == std::io::ErrorKind::TimedOut => {
                return Err("健康检查响应超时".to_string());
            }
            Err(error) => return Err(format!("读取健康检查响应失败：{error}")),
        }
    }

    parse_service_response(&response, expected_service)
}

fn parse_service_response(response: &[u8], expected_service: &str) -> Result<(), String> {
    let text = std::str::from_utf8(response).map_err(|_| "健康检查响应不是 UTF-8".to_string())?;
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "健康检查响应缺少 HTTP header/body 分隔".to_string())?;
    let status = head.lines().next().unwrap_or_default();
    if !(status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")) {
        return Err(format!("健康检查 HTTP 状态异常：{status}"));
    }
    let payload: Value = serde_json::from_str(body.trim())
        .map_err(|error| format!("健康检查 JSON 无效：{error}"))?;
    let service = payload.get("service").and_then(Value::as_str).unwrap_or_default();
    let state = payload.get("status").and_then(Value::as_str).unwrap_or_default();
    if service != expected_service {
        return Err(format!("端口服务身份不匹配：期望 {expected_service}，实际 {service}"));
    }
    if state != "ok" {
        return Err(format!("服务健康状态异常：{state}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_service_response, probe_service};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    #[test]
    fn accepts_expected_service_identity() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\",\"service\":\"mirrororder-host\"}";
        assert!(parse_service_response(response, "mirrororder-host").is_ok());
    }

    #[test]
    fn rejects_wrong_process_on_reserved_port() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\",\"service\":\"mirrororder-gateway\"}";
        let error = parse_service_response(response, "mirrororder-host").unwrap_err();
        assert!(error.contains("身份不匹配"));
    }

    #[test]
    fn probes_real_loopback_http_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let size = stream.read(&mut request).unwrap();
            let text = String::from_utf8_lossy(&request[..size]);
            assert!(text.starts_with("GET /api/v1/ping "));
            let body = r#"{"status":"ok","service":"mirrororder-gateway"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        probe_service(port, "mirrororder-gateway", Duration::from_secs(1)).unwrap();
        server.join().unwrap();
    }
}

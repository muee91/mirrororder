use std::io::{self, Read};

use mirrororder_timeline_core::timebase::execute_request;
use serde_json::json;

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("failed to read request JSON from stdin");
        std::process::exit(2);
    }
    match execute_request(&input) {
        Ok(response) => match serde_json::to_string(&response) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => {
                eprintln!("failed to encode response JSON: {error}");
                std::process::exit(2);
            }
        },
        Err(error) => {
            let response = json!({
                "contract": mirrororder_timeline_core::timebase::TIMEBASE_CONTRACT,
                "error": {"code": error.code, "message": error.message},
            });
            println!(
                "{}",
                serde_json::to_string(&response).expect("error response is serializable")
            );
            std::process::exit(2);
        }
    }
}

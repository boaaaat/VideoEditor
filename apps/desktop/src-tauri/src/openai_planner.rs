use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::env;
use std::time::Duration;

const DEFAULT_MODEL: &str = "gpt-5.4-mini";
const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

pub fn has_api_key() -> bool {
    env::var("OPENAI_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub fn generate_openai_proposal(goal: &str, media: &Value, timeline: &Value) -> Result<Value, String> {
    let api_key = env::var("OPENAI_API_KEY")
        .map_err(|_| "OPENAI_API_KEY is not set; using heuristic planner".to_string())?;
    if api_key.trim().is_empty() {
        return Err("OPENAI_API_KEY is empty; using heuristic planner".to_string());
    }

    let body = build_openai_request_body(goal, media, timeline);
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("failed to create OpenAI HTTP client: {error}"))?;

    let response = client
        .post(RESPONSES_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .map_err(|error| format!("OpenAI request failed: {error}"))?;

    let status = response.status();
    let response_json: Value = response
        .json()
        .map_err(|error| format!("OpenAI returned invalid JSON: {error}"))?;

    if !status.is_success() {
        return Err(format!("OpenAI request failed with {status}: {}", compact_json(&response_json)));
    }

    parse_openai_proposal(&response_json)
}

pub fn build_openai_request_body(goal: &str, media: &Value, timeline: &Value) -> Value {
    let model = env::var("OPENAI_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
    json!({
        "model": model,
        "store": false,
        "reasoning": {
            "effort": "low"
        },
        "input": build_planner_prompt(goal, media, timeline),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "rough_cut_proposal",
                "description": "A safe approval-only rough cut proposal for the AI Video Editor timeline.",
                "strict": true,
                "schema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["explanation", "commands"],
                    "properties": {
                        "explanation": { "type": "string" },
                        "commands": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["type", "clipId", "mediaId", "trackId", "startUs", "inUs", "outUs"],
                                "properties": {
                                    "type": { "type": "string", "enum": ["add_clip"] },
                                    "clipId": { "type": "string" },
                                    "mediaId": { "type": "string" },
                                    "trackId": { "type": "string", "enum": ["v1"] },
                                    "startUs": { "type": "integer" },
                                    "inUs": { "type": "integer" },
                                    "outUs": { "type": "integer" }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

pub fn parse_openai_proposal(response: &Value) -> Result<Value, String> {
    let text = find_output_text(response)
        .ok_or_else(|| format!("OpenAI response did not include output_text: {}", compact_json(response)))?;
    let proposal: Value = serde_json::from_str(text)
        .map_err(|error| format!("OpenAI output was not proposal JSON: {error}"))?;

    let explanation = proposal
        .get("explanation")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if explanation.is_empty() {
        return Err("OpenAI proposal is missing explanation".to_string());
    }

    let commands = proposal
        .get("commands")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI proposal is missing commands".to_string())?;
    if commands.is_empty() {
        return Err("OpenAI proposal did not include any commands".to_string());
    }

    Ok(proposal)
}

fn build_planner_prompt(goal: &str, media: &Value, timeline: &Value) -> String {
    format!(
        "You are the rough-cut planner for an AI-native video editor.\n\
         Produce only approval-safe timeline commands. Do not claim the edit has been applied.\n\
         Use only selected media IDs. Keep all clips on track v1. Use microseconds for time.\n\
         Make sequential add_clip commands whose total visible duration fits the user's goal.\n\n\
         User goal:\n{goal}\n\n\
         Selected media JSON:\n{}\n\n\
         Current timeline JSON:\n{}",
        compact_json(media),
        compact_json(timeline)
    )
}

fn find_output_text(response: &Value) -> Option<&str> {
    response
        .get("output")
        .and_then(Value::as_array)?
        .iter()
        .flat_map(|item| item.get("content").and_then(Value::as_array).into_iter().flatten())
        .find_map(|content| {
            if content.get("type").and_then(Value::as_str) == Some("output_text") {
                content.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[cfg(test)]
mod tests {
    use super::{build_openai_request_body, parse_openai_proposal};
    use serde_json::json;

    #[test]
    fn builds_gpt_5_4_mini_structured_output_request() {
        let body = build_openai_request_body(
            "make a 15 second intro",
            &json!([{
                "id": "media_1",
                "name": "clip.mp4",
                "kind": "video",
                "metadata": { "durationUs": 24000000, "width": 1920, "height": 1080, "fps": 30.0 }
            }]),
            &json!({ "tracks": [] }),
        );

        assert_eq!(body["model"], "gpt-5.4-mini");
        assert_eq!(body["store"], false);
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["text"]["format"]["name"], "rough_cut_proposal");
        assert!(body["input"].as_str().unwrap().contains("make a 15 second intro"));
        assert!(body["input"].as_str().unwrap().contains("media_1"));
    }

    #[test]
    fn parses_responses_output_text_into_proposal_json() {
        let response = json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "{\"explanation\":\"Selected the clearest opener.\",\"commands\":[{\"type\":\"add_clip\",\"clipId\":\"ai_1\",\"mediaId\":\"media_1\",\"trackId\":\"v1\",\"startUs\":0,\"inUs\":0,\"outUs\":5000000}]}"
                }]
            }]
        });

        let proposal = parse_openai_proposal(&response).expect("proposal should parse");

        assert_eq!(proposal["explanation"], "Selected the clearest opener.");
        assert_eq!(proposal["commands"][0]["type"], "add_clip");
        assert_eq!(proposal["commands"][0]["clipId"], "ai_1");
    }
}

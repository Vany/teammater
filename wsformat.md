# WebSocket Message Format

## Protocol Design
- **Minimal bandwidth**: text-only, incremental updates
- **AI-optimized**: explicit typing, predictable structure
- **No spam**: empty results suppressed, error code 7 filtered
- **Incremental partials**: only new words sent (diff-based)

## Message Types

### `hello` - Handshake (sent on connect)
```json
{"type":"hello","device_name":"UH Service","protocol_version":1,"timestamp":1736707200000}
```
- `device_name`: string - device identity for auth
- `protocol_version`: int - currently 1
- `timestamp`: long - server time (ms epoch)

### `partial_result` - Incremental Transcription
```json
{"type":"partial_result","text":"world","timestamp":1736707201234,"session_start":1736707200000}
```
- `text`: string - **NEW words only** since last partial (diff)
- `timestamp`: long - message time
- `session_start`: long - recognition session start
- **Frequency**: 0.5-2 Hz during speech
- **Example**: "hello" → "hello world" sends only "world"

### `final_result` - Complete Result + Metadata
```json
{
  "type":"final_result",
  "alternatives":[
    {"text":"Hello world","confidence":0.95},
    {"text":"Hello word","confidence":0.72}
  ],
  "best_text":"Hello world",
  "best_confidence":0.95,
  "language":"en-US",
  "timestamp":1736707202000,
  "session_start":1736707200000,
  "session_duration_ms":2000,
  "speech_start":1736707200500,
  "speech_duration_ms":1500
}
```
- `alternatives`: array[object] - top N results (max 5), sorted by confidence
  - `text`: string - complete transcription
  - `confidence`: float [0.0-1.0] - higher is better
- `best_text`: string - highest confidence result
- `best_confidence`: float - confidence of best result
- `language`: string - language code (en-US, ru-RU)
- `timestamp`: long - result finalized time
- `session_start`: long - recognition start
- `session_duration_ms`: long - ready → result duration
- `speech_start`: long - user speech start
- `speech_duration_ms`: long - speech duration
- **Frequency**: once per utterance (2-10s typical)

### `recognition_error` - Error Events (filtered)
```json
{"type":"recognition_error","error_code":2,"error_message":"Network error","timestamp":1736707202500,"auto_restart":true}
```
- `error_code`: int - Android SpeechRecognizer error code
  - 1=NETWORK_TIMEOUT, 2=NETWORK, 3=AUDIO, 4=SERVER, 5=CLIENT, 6=SPEECH_TIMEOUT, 8=RECOGNIZER_BUSY, 9=INSUFFICIENT_PERMISSIONS
  - **7=NO_MATCH suppressed** (normal silence)
- `error_message`: string - human-readable
- `timestamp`: long
- `auto_restart`: bool - will auto-restart?
- **Frequency**: sparse, real errors only

### `audio_level` - RMS dB (deprecated, in code but marked for removal)
```json
{"type":"audio_level","rms_db":-32.5,"listening":true,"timestamp":1736707200100}
```
- **Status**: spam, marked for removal per ANDROID_STT_PROTOCOL.md

### `recognition_event` - State Changes (deprecated, marked for removal)
```json
{"type":"recognition_event","event":"ready_for_speech","timestamp":1736707200000,"listening":true}
```
- `event`: string - ready_for_speech, speech_start, speech_end, listening_started, listening_stopped
- **Status**: spam, marked for removal per ANDROID_STT_PROTOCOL.md

### `audio_status` - Backward Compat (deprecated)
```json
{"type":"audio_status","listening":true,"audio_level":0.75,"timestamp":1736707200000}
```
- **Status**: legacy compatibility, redundant

## Typical Flow
```
[T=0]     hello
[T+800]   partial_result:"hello"
[T+1500]  partial_result:"world"    # incremental: only new word
[T+2200]  final_result:"hello world" # alternatives + confidence
```
**3 messages/utterance** (~500-1000 bytes)

## Client Pattern
```javascript
let currentText = '';
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  switch(m.type) {
    case 'hello': /* verify device_name for auth */ break;
    case 'partial_result': currentText += (currentText?' ':'')+m.text; break;
    case 'final_result': /* use m.best_text, reset currentText */ break;
    case 'recognition_error': /* log, reset currentText */ break;
  }
};
```

## Language Support
- `en-US` (English)
- `ru-RU` (Russian)
- Changed via UI or WebSocket command (future)

## Notes
- **No embeddings**: Android STT doesn't provide semantic vectors
- **Network-dependent**: cloud STT for accuracy (device-dependent)
- **APK**: ~12MB (no bundled models)
- **Latency**: 100-300ms (platform STT)

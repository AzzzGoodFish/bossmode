#!/bin/bash
# C1: Verify stream-json input/output protocol
# Send a simple message, capture all output

echo '{"type":"user","content":[{"type":"text","text":"What is 2+2? Reply with just the number."}]}' | \
  claude --input-format stream-json --output-format stream-json --print --dangerously-skip-permissions --no-session-persistence 2>/dev/null

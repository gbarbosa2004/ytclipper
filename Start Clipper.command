#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if curl --silent --fail --max-time 2 http://127.0.0.1:4317/api/status >/dev/null; then
  open http://127.0.0.1:4317
  exit 0
fi
if ! command -v node >/dev/null; then
  print 'Node.js is missing. Install it with: brew install node'
  read '?Press Enter to close.'
  exit 1
fi
node server.mjs &
clipper_pid=$!
trap 'kill "$clipper_pid" 2>/dev/null' EXIT INT TERM
for attempt in {1..40}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:4317/api/status >/dev/null; then
    open http://127.0.0.1:4317
    break
  fi
  if ! kill -0 "$clipper_pid" 2>/dev/null; then
    read '?Could not start Clipper. Press Enter to close.'
    exit 1
  fi
  sleep 0.25
done
wait "$clipper_pid"

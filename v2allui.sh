#!/usr/bin/env bash
set -u
bash v2ui.sh
v2=$?
bash v1ui.sh
v1=$?
printf '{"v2Exit":%s,"v1Exit":%s}\n' "$v2" "$v1" > evidence/v2-browser/all-ui-exit.json
exit $((v2 || v1))

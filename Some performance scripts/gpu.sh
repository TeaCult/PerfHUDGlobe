gpu_util_pct() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -n1
    return
  fi

  for f in /sys/class/drm/card*/device/gpu_busy_percent /sys/class/drm/card*/device/gt_busy_percent; do
    [ -r "$f" ] && cat "$f" && return
  done

  for f in /sys/kernel/debug/dri/*/amdgpu_pm_info; do
    [ -r "$f" ] && awk '/GPU Load/ {gsub(/%/,"",$3); print $3; exit}' "$f" && return
  done

  echo "null"
}

echo "gpu_util_pct: $(gpu_util_pct)"


#!/usr/bin/env bash
read_cpu() { awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat; } # u n s id iw irq sirq st

prev=($(read_cpu)); prev_t=$(date +%s)

while sleep 1; do
  now=($(read_cpu)); now_t=$(date +%s)
  dt=$((now_t-prev_t)); ((dt<=0)) && dt=1

  # deltas
  du=$((now[0]-prev[0])); dn=$((now[1]-prev[1])); ds=$((now[2]-prev[2]))
  did=$((now[3]-prev[3])); diw=$((now[4]-prev[4])); dirq=$((now[5]-prev[5]))
  dsq=$((now[6]-prev[6])); dst=$((now[7]-prev[7]))
  dtotal=$((du+dn+ds+did+diw+dirq+dsq+dst))
  ((dtotal<=0)) && dtotal=1

  cpu_total_pct=$(awk -v dt=$dtotal -v idle=$did -v iw=$diw 'BEGIN{printf "%.3f", 100*(dt-(idle+iw))/dt}')
  cpu_iowait_pct=$(awk -v dt=$dtotal -v iw=$diw 'BEGIN{printf "%.3f", 100*iw/dt}')

  # loadavg
  read l1 l5 l15 _ </proc/loadavg

  # PSI avg10
  psi_cpu_some=$(awk '/^some/{for(i=1;i<=NF;i++)if($i~/^avg10=/){sub("avg10=","",$i);print $i}}' /proc/pressure/cpu)
  psi_cpu_full=$(awk '/^full/{for(i=1;i<=NF;i++)if($i~/^avg10=/){sub("avg10=","",$i);print $i}}' /proc/pressure/cpu)
  psi_mem_some=$(awk '/^some/{for(i=1;i<=NF;i++)if($i~/^avg10=/){sub("avg10=","",$i);print $i}}' /proc/pressure/memory)
  psi_mem_full=$(awk '/^full/{for(i=1;i<=NF;i++)if($i~/^avg10=/){sub("avg10=","",$i);print $i}}' /proc/pressure/memory)
  psi_io_some=$(awk '/^some/{for(i=1;i<=NF;i++)if($i~/^avg10=/){sub("avg10=","",$i);print $i}}' /proc/pressure/io)
  psi_io_full=$(awk '/^full/{for(i=1;i<=NF;i++)if($i~/^avg10=/){sub("avg10=","",$i);print $i}}' /proc/pressure/io)

  # meminfo (MB)
  mem_total=$(awk '/MemTotal:/{print int($2/1024)}' /proc/meminfo)
  mem_avail=$(awk '/MemAvailable:/{print int($2/1024)}' /proc/meminfo)
  swap_free=$(awk '/SwapFree:/{print int($2/1024)}' /proc/meminfo)
  swap_total=$(awk '/SwapTotal:/{print int($2/1024)}' /proc/meminfo)
  swap_used=$((swap_total-swap_free))

  # net dev (sum)
  net=$(awk 'NR>2{rx+=$2; tx+=$10} END{print rx,tx}' /proc/net/dev)
  rx_bytes=$(awk '{print $1}' <<<"$net")
  tx_bytes=$(awk '{print $2}' <<<"$net")

  printf '{"ts":%s,"cpu_total_pct":%s,"cpu_iowait_pct":%s,"load1":%s,"load5":%s,"load15":%s,' \
    "$(date +%s%3N)" "$cpu_total_pct" "$cpu_iowait_pct" "$l1" "$l5" "$l15"
  printf '"cpu_psi_some":%s,"cpu_psi_full":%s,"mem_psi_some":%s,"mem_psi_full":%s,"io_psi_some":%s,"io_psi_full":%s,' \
    "${psi_cpu_some:-0}" "${psi_cpu_full:-0}" "${psi_mem_some:-0}" "${psi_mem_full:-0}" "${psi_io_some:-0}" "${psi_io_full:-0}"
  printf '"mem_total_mb":%s,"mem_avail_mb":%s,"swap_used_mb":%s,"rx_bytes_total":%s,"tx_bytes_total":%s}\n' \
    "$mem_total" "$mem_avail" "$swap_used" "$rx_bytes" "$tx_bytes"

  echo "----"
  printf "CPU total:        %6.2f %%\n" "$cpu_total_pct"
  printf "CPU iowait:       %6.2f %%\n" "$cpu_iowait_pct"
  printf "Load (1/5/15):    %s / %s / %s\n" "$l1" "$l5" "$l15"
  printf "PSI CPU (s/f):    %s / %s\n" "${psi_cpu_some:-0}" "${psi_cpu_full:-0}"
  printf "PSI MEM (s/f):    %s / %s\n" "${psi_mem_some:-0}" "${psi_mem_full:-0}"
  printf "PSI IO  (s/f):    %s / %s\n" "${psi_io_some:-0}" "${psi_io_full:-0}"
  printf "Mem total/avail:  %s / %s MB\n" "$mem_total" "$mem_avail"
  printf "Swap used:        %s MB\n" "$swap_used"
  printf "Net RX/TX total:  %s / %s bytes\n" "$rx_bytes" "$tx_bytes"
  echo

  prev=("${now[@]}"); prev_t=$now_t1
done


  # ---- pretty output ----

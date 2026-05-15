#!/usr/bin/env bash
hz=10; dt=$(awk -v h=$hz 'BEGIN{print 1/h}')

read_cpu(){ awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat; }         # u n s id iw irq sirq st
read_net(){ awk 'NR>2{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev; }      # totals
read_disk(){ awk '{r+=$6;w+=$10;rio+=$4;wio+=$8}END{print r,w,rio,wio}' /proc/diskstats; } # sectors + ios

cpu0=($(read_cpu)); net0=($(read_net)); d0=($(read_disk))
t0=$(date +%s%N)

while sleep "$dt"; do
  cpu1=($(read_cpu)); net1=($(read_net)); d1=($(read_disk))
  t1=$(date +%s%N); dt_s=$(awk -v a=$t0 -v b=$t1 'BEGIN{print (b-a)/1e9}'); t0=$t1

  # CPU %
  du=$((cpu1[0]-cpu0[0])); dn=$((cpu1[1]-cpu0[1])); ds=$((cpu1[2]-cpu0[2]))
  did=$((cpu1[3]-cpu0[3])); diw=$((cpu1[4]-cpu0[4])); dirq=$((cpu1[5]-cpu0[5]))
  dsq=$((cpu1[6]-cpu0[6])); dst=$((cpu1[7]-cpu0[7]))
  total=$((du+dn+ds+did+diw+dirq+dsq+dst)); ((total<=0)) && total=1
  cpu_pct=$(awk -v tot=$total -v idle=$did -v iw=$diw 'BEGIN{printf "%.1f",100*(tot-(idle+iw))/tot}')
  iow_pct=$(awk -v tot=$total -v iw=$diw 'BEGIN{printf "%.1f",100*iw/tot}')
  cpu0=("${cpu1[@]}")

  # NET B/s
  rx=$((net1[0]-net0[0])); tx=$((net1[1]-net0[1])); net0=("${net1[@]}")
  rx_bps=$(awk -v x=$rx -v d=$dt_s 'BEGIN{printf "%.0f",x/d}')
  tx_bps=$(awk -v x=$tx -v d=$dt_s 'BEGIN{printf "%.0f",x/d}')

  # DISK (sectors → bytes, assume 512B sectors)
  dr=$((d1[0]-d0[0])); dw=$((d1[1]-d0[1])); drio=$((d1[2]-d0[2])); dwio=$((d1[3]-d0[3])); d0=("${d1[@]}")
  rd_bps=$(awk -v s=$dr -v d=$dt_s 'BEGIN{printf "%.0f",(s*512)/d}')
  wr_bps=$(awk -v s=$dw -v d=$dt_s 'BEGIN{printf "%.0f",(s*512)/d}')
  rio_ps=$(awk -v x=$drio -v d=$dt_s 'BEGIN{printf "%.1f",x/d}')
  wio_ps=$(awk -v x=$dwio -v d=$dt_s 'BEGIN{printf "%.1f",x/d}')

  printf "CPU %5s%% (iow %4s%%) | NET ↓%8sB/s ↑%8sB/s | DISK R%8sB/s W%8sB/s IOPS %5s/%5s\n" \
    "$cpu_pct" "$iow_pct" "$rx_bps" "$tx_bps" "$rd_bps" "$wr_bps" "$rio_ps" "$wio_ps"
done

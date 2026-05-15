#!/usr/bin/env bash
# proc_1hz.sh  (Bash 4+)
# JSON + pretty output, per-interface and per-disk, using /proc only.

SECTOR_BYTES=512

is_disk() {
  local n="$1"
  [[ "$n" =~ ^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+|bcache[0-9]+)$ ]]
}

now_ns(){ date +%s%N; }

read_net() {
  # iface rxB rxErr rxDrop txB txErr txDrop
  awk 'NR>2{
    gsub(":", "", $1);
    iface=$1;
    rxB=$2; rxErr=$4; rxDrop=$5;
    txB=$10; txErr=$12; txDrop=$13;
    print iface, rxB, rxErr, rxDrop, txB, txErr, txDrop
  }' /proc/net/dev
}

read_disks() {
  # name reads ms_reading writes ms_writing inflight ms_doing_io sectors_read sectors_written
  awk '{
    name=$3;
    reads=$4; sectorsR=$6; msR=$7;
    writes=$8; sectorsW=$10; msW=$11;
    inflight=$12; msDoing=$13;
    print name, reads, msR, writes, msW, inflight, msDoing, sectorsR, sectorsW
  }' /proc/diskstats
}

# ---- state ----
declare -A NRX NTX NRE NTD NRD NDD
declare -A DRC DWC DMR DMW DINF DMSD DSR DSW

t0=$(now_ns)

# init net
while read -r i rx re rd tx te td; do
  [[ "$i" == "lo" ]] && continue
  NRX["$i"]=$rx; NRE["$i"]=$re; NRD["$i"]=$rd
  NTX["$i"]=$tx; NTD["$i"]=$te; NDD["$i"]=$td
done < <(read_net)

# init disks
while read -r n rc mr wc mw inf msd sr sw; do
  is_disk "$n" || continue
  DRC["$n"]=$rc; DMR["$n"]=$mr
  DWC["$n"]=$wc; DMW["$n"]=$mw
  DINF["$n"]=$inf; DMSD["$n"]=$msd
  DSR["$n"]=$sr; DSW["$n"]=$sw
done < <(read_disks)

while sleep 1; do
  t1=$(now_ns)
  dt=$(awk -v a="$t0" -v b="$t1" 'BEGIN{d=(b-a)/1e9; if(d<=0)d=1; print d}')
  dt_ms=$(awk -v d="$dt" 'BEGIN{print d*1000}')
  t0=$t1

  # ---- NET per iface ----
  declare -A rx_bps tx_bps rxerr_ps txerr_ps rxdrop_ps txdrop_ps

  while read -r i rx re rd tx te td; do
    [[ "$i" == "lo" ]] && continue
    prx=${NRX["$i"]:-$rx}; ptx=${NTX["$i"]:-$tx}
    pre=${NRE["$i"]:-$re}; pte=${NTD["$i"]:-$te}
    prd=${NRD["$i"]:-$rd}; ptd=${NDD["$i"]:-$td}

    drx=$((rx-prx)); dtx=$((tx-ptx))
    dre=$((re-pre)); dte=$((te-pte))
    drd=$((rd-prd)); dtd=$((td-ptd))

    rx_bps["$i"]=$(awk -v x="$drx" -v d="$dt" 'BEGIN{printf "%.0f", x/d}')
    tx_bps["$i"]=$(awk -v x="$dtx" -v d="$dt" 'BEGIN{printf "%.0f", x/d}')
    rxerr_ps["$i"]=$(awk -v x="$dre" -v d="$dt" 'BEGIN{printf "%.3f", x/d}')
    txerr_ps["$i"]=$(awk -v x="$dte" -v d="$dt" 'BEGIN{printf "%.3f", x/d}')
    rxdrop_ps["$i"]=$(awk -v x="$drd" -v d="$dt" 'BEGIN{printf "%.3f", x/d}')
    txdrop_ps["$i"]=$(awk -v x="$dtd" -v d="$dt" 'BEGIN{printf "%.3f", x/d}')

    NRX["$i"]=$rx; NTX["$i"]=$tx
    NRE["$i"]=$re; NTD["$i"]=$te
    NRD["$i"]=$rd; NDD["$i"]=$td
  done < <(read_net)

  # ---- DISK per disk ----
  declare -A rd_bps wr_bps rio_ps wio_ps util_pct inflight avg_lat_ms

  while read -r n rc mr wc mw inf msd sr sw; do
    is_disk "$n" || continue

    prc=${DRC["$n"]:-$rc}; pwc=${DWC["$n"]:-$wc}
    pmr=${DMR["$n"]:-$mr}; pmw=${DMW["$n"]:-$mw}
    pmsd=${DMSD["$n"]:-$msd}
    psr=${DSR["$n"]:-$sr}; psw=${DSW["$n"]:-$sw}

    drc=$((rc-prc)); dwc=$((wc-pwc))
    dmr=$((mr-pmr)); dmw=$((mw-pmw))
    dmsd=$((msd-pmsd))
    dsr=$((sr-psr)); dsw=$((sw-psw))

    rd_bps["$n"]=$(awk -v s="$dsr" -v d="$dt" -v b="$SECTOR_BYTES" 'BEGIN{printf "%.0f",(s*b)/d}')
    wr_bps["$n"]=$(awk -v s="$dsw" -v d="$dt" -v b="$SECTOR_BYTES" 'BEGIN{printf "%.0f",(s*b)/d}')
    rio_ps["$n"]=$(awk -v x="$drc" -v d="$dt" 'BEGIN{printf "%.3f", x/d}')
    wio_ps["$n"]=$(awk -v x="$dwc" -v d="$dt" 'BEGIN{printf "%.3f", x/d}')

    util_pct["$n"]=$(awk -v ms="$dmsd" -v dtms="$dt_ms" 'BEGIN{u=(dtms>0)?(100*ms/dtms):0; if(u<0)u=0; if(u>100)u=100; printf "%.2f", u}')
    inflight["$n"]=$inf

    ios=$((drc+dwc))
    avg_lat_ms["$n"]=$(awk -v ms="$((dmr+dmw))" -v io="$ios" 'BEGIN{ if(io>0) printf "%.3f", ms/io; else print "null" }')

    DRC["$n"]=$rc; DWC["$n"]=$wc
    DMR["$n"]=$mr; DMW["$n"]=$mw
    DMSD["$n"]=$msd
    DSR["$n"]=$sr; DSW["$n"]=$sw
    DINF["$n"]=$inf
  done < <(read_disks)

  # ---- JSON ----
  # ifaces object
  iface_json=""
  for i in "${!rx_bps[@]}"; do
    iface_json+=$(printf '%s"%s":{"rx_bps":%s,"tx_bps":%s,"rx_err_ps":%s,"tx_err_ps":%s,"rx_drop_ps":%s,"tx_drop_ps":%s}' \
      "${iface_json:+,}" "$i" "${rx_bps[$i]}" "${tx_bps[$i]}" "${rxerr_ps[$i]}" "${txerr_ps[$i]}" "${rxdrop_ps[$i]}" "${txdrop_ps[$i]}")
  done

  disk_json=""
  for n in "${!rd_bps[@]}"; do
    disk_json+=$(printf '%s"%s":{"read_bps":%s,"write_bps":%s,"read_iops":%s,"write_iops":%s,"util_pct":%s,"inflight":%s,"avg_lat_ms":%s}' \
      "${disk_json:+,}" "$n" "${rd_bps[$n]}" "${wr_bps[$n]}" "${rio_ps[$n]}" "${wio_ps[$n]}" "${util_pct[$n]}" "${inflight[$n]}" "${avg_lat_ms[$n]}")
  done

  printf '{"ts":%s,"dt_s":%s,"ifaces":{%s},"disks":{%s}}\n' "$(date +%s%3N)" "$dt" "$iface_json" "$disk_json"

  # ---- pretty ----
  echo "---- NET (per iface) ----"
  for i in "${!rx_bps[@]}"; do
    printf "%-10s ↓ %10s B/s  ↑ %10s B/s  drop %s/%s  err %s/%s\n" \
      "$i" "${rx_bps[$i]}" "${tx_bps[$i]}" "${rxdrop_ps[$i]}" "${txdrop_ps[$i]}" "${rxerr_ps[$i]}" "${txerr_ps[$i]}"
  done

  echo "---- DISK (per disk) ----"
  for n in "${!rd_bps[@]}"; do
    printf "%-10s R %10s B/s  W %10s B/s  IOPS %7s/%7s  util %6s%%  inflight %3s  lat %s ms\n" \
      "$n" "${rd_bps[$n]}" "${wr_bps[$n]}" "${rio_ps[$n]}" "${wio_ps[$n]}" "${util_pct[$n]}" "${inflight[$n]}" "${avg_lat_ms[$n]}"
  done
  echo
done

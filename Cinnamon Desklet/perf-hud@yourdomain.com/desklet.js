const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;

class PerfHudDesklet extends Desklet.Desklet {
    constructor(metadata, desklet_id) {
        super(metadata, desklet_id);

        this.setHeader("System HUD");

        // State tracking for delta calculations
        this.lastCpu = { idle: 0, total: 0 };
        this.lastNet = { rx: 0, tx: 0, time: GLib.get_monotonic_time() };
        this.lastDisk = { read: 0, write: 0, time: GLib.get_monotonic_time() };
        this.logLines = [];
        this.maxLogLines = 15;

        this.setupUI();
        this.startLogStream();

        // 1000ms polling loop
        this.updateLoop = Mainloop.timeout_add(1000, () => this.updateMetrics());
    }

    setupUI() {
        this.container = new St.BoxLayout({ vertical: true, style_class: "hud-container" });
        this.metricsBox = new St.BoxLayout({ vertical: true, style_class: "metrics-box" });

        // Row 1: CPU, GPU, MEM
        let row1 = new St.BoxLayout({ style_class: "metric-row" });
        this.cpuLabel = new St.Label({ text: "CPU: --%" });
        this.gpuLabel = new St.Label({ text: "GPU: --%" }); // Placeholder: requires complex async polling in GJS
        this.memLabel = new St.Label({ text: "MEM: --%" });
        row1.add_actor(this.cpuLabel);
        row1.add_actor(this.gpuLabel);
        row1.add_actor(this.memLabel);

        // Row 2: NET
        let row2 = new St.BoxLayout({ style_class: "metric-row" });
        this.netLabel = new St.Label({ text: "NET: ↓ 0 B/s  ↑ 0 B/s" });
        row2.add_actor(this.netLabel);

        // Row 3: DISK
        let row3 = new St.BoxLayout({ style_class: "metric-row" });
        this.diskLabel = new St.Label({ text: "DISK: R 0 B/s  W 0 B/s" });
        row3.add_actor(this.diskLabel);

        this.metricsBox.add_actor(row1);
        this.metricsBox.add_actor(row2);
        this.metricsBox.add_actor(row3);

        // Logs
        this.logContainer = new St.BoxLayout({ vertical: true, style_class: "log-panel" });

        this.container.add_actor(this.metricsBox);
        this.container.add_actor(this.logContainer);

        this.setContent(this.container);
    }

    getFileContents(path) {
        try {
            let [success, contents] = GLib.file_get_contents(path);
            if (success) return new TextDecoder('utf-8').decode(contents);
        } catch (e) { }
        return "";
    }

    formatRate(bps) {
        if (bps < 1024) return `${bps.toFixed(0)} B/s`;
        if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
        return `${(bps / 1000000).toFixed(2)} MB/s`;
    }

    updateMetrics() {
        let now = GLib.get_monotonic_time();

        // --- MEMORY ---
        let meminfo = this.getFileContents('/proc/meminfo');
        if (meminfo) {
            let total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || 0);
            let avail = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || 0);
            if (total > 0) {
                this.memLabel.set_text(`MEM: ${(((total - avail) / total) * 100).toFixed(0)}%`);
            }
        }

        // --- CPU ---
        let stat = this.getFileContents('/proc/stat').split('\n')[0];
        if (stat && stat.startsWith('cpu ')) {
            let parts = stat.match(/\d+/g).map(Number);
            let idle = parts[3] + parts[4]; // idle + iowait
            let total = parts.reduce((a, b) => a + b, 0);

            let deltaIdle = idle - this.lastCpu.idle;
            let deltaTotal = total - this.lastCpu.total;
            let cpuPct = (1.0 - (deltaIdle / deltaTotal)) * 100;

            this.cpuLabel.set_text(`CPU: ${cpuPct.toFixed(0)}%`);
            this.lastCpu = { idle, total };
        }

        // --- NETWORK ---
        let netDev = this.getFileContents('/proc/net/dev');
        let rxSum = 0, txSum = 0;
        let lines = netDev.split('\n').slice(2);
        for (let line of lines) {
            if (!line || line.includes('lo:')) continue;
            let parts = line.trim().split(/\s+/);
            rxSum += parseInt(parts[1] || 0);
            txSum += parseInt(parts[9] || 0);
        }

        let dtNet = (now - this.lastNet.time) / 1000000.0;
        if (dtNet > 0) {
            let rxBps = (rxSum - this.lastNet.rx) / dtNet;
            let txBps = (txSum - this.lastNet.tx) / dtNet;
            this.netLabel.set_text(`NET: ↓ ${this.formatRate(rxBps)}  ↑ ${this.formatRate(txBps)}`);
        }
        this.lastNet = { rx: rxSum, tx: txSum, time: now };

        // --- DISK ---
        let diskstats = this.getFileContents('/proc/diskstats');
        let readSum = 0, writeSum = 0;
        let diskLines = diskstats.split('\n');
        for (let line of diskLines) {
            let parts = line.trim().split(/\s+/);
            if (parts.length < 14 || parts[1] !== "0") continue; // minor==0 (whole drives)
            if (/^(loop|ram|sr|fd|zram)/.test(parts[2])) continue;

            readSum += parseInt(parts[5] || 0) * 512;
            writeSum += parseInt(parts[9] || 0) * 512;
        }

        let dtDisk = (now - this.lastDisk.time) / 1000000.0;
        if (dtDisk > 0) {
            let rBps = (readSum - this.lastDisk.read) / dtDisk;
            let wBps = (writeSum - this.lastDisk.write) / dtDisk;
            this.diskLabel.set_text(`DISK: R ${this.formatRate(rBps)}  W ${this.formatRate(wBps)}`);
        }
        this.lastDisk = { read: readSum, write: writeSum, time: now };

        return true; // Keep loop alive
    }

    startLogStream() {
        try {
            // Non-blocking async stdout stream for journalctl
            this.proc = new Gio.Subprocess({
                argv: ['journalctl', '-f', '-o', 'json', '-n', '0'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE
            });
            this.proc.init(null);

            let stdoutStream = this.proc.get_stdout_pipe();
            this.dataStream = new Gio.DataInputStream({ base_stream: stdoutStream });
            this.readNextLogLine();
        } catch (e) {
            global.logError("Failed to start journalctl: " + e);
        }
    }

    readNextLogLine() {
        this.dataStream.read_line_async(0, null, (stream, res) => {
            try {
                let [lineBytes, length] = stream.read_line_finish_utf8(res);
                if (lineBytes !== null) {
                    this.processLogEntry(lineBytes);
                    this.readNextLogLine(); // Recursive async loop
                }
            } catch (e) {
                global.logError(e);
            }
        });
    }

    processLogEntry(jsonStr) {
        try {
            let j = JSON.parse(jsonStr);
            let pri = parseInt(j.PRIORITY || "6");
            let comm = j._SYSTEMD_UNIT || j._COMM || "";
            let msg = j.MESSAGE || "";
            let text = `${comm ? '[' + comm + '] ' : ''}${msg}`.substring(0, 80);

            let label = new St.Label({ text: text });

            if (pri <= 3) label.add_style_class_name("log-err");
            else if (pri === 4) label.add_style_class_name("log-warn");
            else label.add_style_class_name("log-info");

            this.logContainer.add_actor(label);
            this.logLines.push(label);

            if (this.logLines.length > this.maxLogLines) {
                let oldLabel = this.logLines.shift();
                this.logContainer.remove_actor(oldLabel);
                oldLabel.destroy();
            }
        } catch (e) { }
    }

    on_desklet_removed() {
        if (this.updateLoop) Mainloop.source_remove(this.updateLoop);
        if (this.proc) this.proc.force_exit();
    }
}

function main(metadata, desklet_id) {
    return new PerfHudDesklet(metadata, desklet_id);
}
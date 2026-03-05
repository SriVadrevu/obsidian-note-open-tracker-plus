const { Plugin, PluginSettingTab, Setting, normalizePath } = require("obsidian");

const DEFAULT_SETTINGS = {
  statsFolder: "_Archives/_stats",               // vault-relative folder
  reportFileName: "Note Open Analytics.md",      // stored inside statsFolder
  writeDebounceMs: 3000,                         // reduce sync churn vs 1500ms
  trackNonMarkdown: false,                       // by default only .md notes
  enableEventLog: true,                          // writes NDJSON event log
  trendingWeights: {                             // score = 30d*w30 + 90d*w90 + 365d*w365
    w30: 5,
    w90: 2,
    w365: 1
  },
  topN: 30                                       // rows per section in report
};

module.exports = class NoteOpenTrackerPlus extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this._pendingWriteTimer = null;
    this._db = null;

    this.addSettingTab(new NoteOpenTrackerPlusSettingTab(this.app, this));

    // Command: manually regenerate report
    this.addCommand({
      id: "regenerate-note-open-report",
      name: "Regenerate Note Open Analytics report",
      callback: async () => {
        await this.ensureStatsFolder();
        await this.writeReport();
      }
    });

    await this.ensureStatsFolder();
    this._db = await this.readDb();

    // Track note opens
    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (!file) return;

        // Track markdown only by default
        if (!this.settings.trackNonMarkdown && file.extension !== "md") return;

        // Ignore the analytics report itself to avoid self-inflation
        const reportPath = this.getReportVaultPath();
        if (normalizePath(file.path) === normalizePath(reportPath)) return;

        const p = file.path;
        const t = new Date().toISOString();

        if (!this._db.notes[p]) {
          this._db.notes[p] = {
            total: 0,
            last_opened: null,
            opens_30d: [],
            opens_90d: [],
            opens_365d: []
          };
        }

        const rec = this._db.notes[p];
        rec.total = (rec.total || 0) + 1;
        rec.last_opened = t;

        rec.opens_30d = this.pruneTimestamps([...(rec.opens_30d || []), t], 30);
        rec.opens_90d = this.pruneTimestamps([...(rec.opens_90d || []), t], 90);
        rec.opens_365d = this.pruneTimestamps([...(rec.opens_365d || []), t], 365);

        if (this.settings.enableEventLog) {
          await this.appendEvent({ ts: t, path: p, type: "open" });
        }

        this.scheduleWrite();
      })
    );

    // Initial report write
    this.scheduleWrite();
  }

  async onunload() {
    // nothing special; any pending timer will be GC'd with plugin unload
  }

  /* -----------------------
     Paths + storage helpers
     ----------------------- */

  getStatsFolderVaultPath() {
    return normalizePath(this.settings.statsFolder || DEFAULT_SETTINGS.statsFolder);
  }

  getDbVaultPath() {
    return normalizePath(`${this.getStatsFolderVaultPath()}/.note-open-tracker-plus.json`);
  }

  getEventsVaultPath() {
    return normalizePath(`${this.getStatsFolderVaultPath()}/.note-open-events.ndjson`);
  }

  getReportVaultPath() {
    return normalizePath(`${this.getStatsFolderVaultPath()}/${this.settings.reportFileName || DEFAULT_SETTINGS.reportFileName}`);
  }

  async ensureStatsFolder() {
    const folder = this.getStatsFolderVaultPath();
    // createFolder throws if exists; ignore
    try { await this.app.vault.createFolder(folder); } catch (_) {}
  }

  async exists(vaultPath) {
    try {
      return await this.app.vault.adapter.exists(vaultPath);
    } catch (_) {
      return false;
    }
  }

  async readText(vaultPath) {
    return await this.app.vault.adapter.read(vaultPath);
  }

  async writeText(vaultPath, content) {
    await this.app.vault.adapter.write(vaultPath, content);
  }

  async appendText(vaultPath, content) {
    const ex = await this.exists(vaultPath);
    if (!ex) {
      await this.writeText(vaultPath, content);
      return;
    }
    // Obsidian adapter doesn't have a universal append; do read+write.
    // For small NDJSON lines, this is acceptable. If you want huge logs, disable event log.
    const prev = await this.readText(vaultPath);
    await this.writeText(vaultPath, prev + content);
  }

  async readDb() {
    const dbPath = this.getDbVaultPath();
    const ex = await this.exists(dbPath);
    if (!ex) return { notes: {} };

    try {
      const raw = await this.readText(dbPath);
      const parsed = JSON.parse(raw || "{}");
      if (!parsed.notes || typeof parsed.notes !== "object") return { notes: {} };
      return parsed;
    } catch (e) {
      console.error("[note-open-tracker-plus] Failed reading DB:", e);
      return { notes: {} };
    }
  }

  async writeDb() {
    const dbPath = this.getDbVaultPath();
    await this.writeText(dbPath, JSON.stringify(this._db, null, 2));
  }

  async appendEvent(evt) {
    const eventsPath = this.getEventsVaultPath();
    await this.appendText(eventsPath, JSON.stringify(evt) + "\n");
  }

  /* -----------------------
     Rolling window helpers
     ----------------------- */

  pruneTimestamps(arr, days) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cut = Date.now() - days * DAY_MS;
    return arr.filter((iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && t >= cut;
    });
  }

  /* -----------------------
     Report generation
     ----------------------- */

  computeStats() {
    const notesObj = this._db.notes || {};
    const { w30, w90, w365 } = this.settings.trendingWeights || DEFAULT_SETTINGS.trendingWeights;

    const entries = Object.entries(notesObj).map(([notePath, rec]) => {
      const total = rec.total || 0;
      const lastOpened = rec.last_opened || null;

      const opens30 = (rec.opens_30d || []).length;
      const opens90 = (rec.opens_90d || []).length;
      const opens365 = (rec.opens_365d || []).length;

      const score = opens30 * (w30 ?? 5) + opens90 * (w90 ?? 2) + opens365 * (w365 ?? 1);

      return { path: notePath, total, lastOpened, opens30, opens90, opens365, score };
    });

    const byTotal = [...entries].sort((a, b) => b.total - a.total);
    const byTrending = [...entries].sort((a, b) => b.score - a.score);
    const byRecent = [...entries].sort((a, b) => {
      const ta = a.lastOpened ? Date.parse(a.lastOpened) : 0;
      const tb = b.lastOpened ? Date.parse(b.lastOpened) : 0;
      return tb - ta;
    });

    return { entries, byTotal, byTrending, byRecent };
  }

  formatReport(stats) {
    const topN = (arr, n) => arr.slice(0, n);

    const fmtRow = (e) => {
      const last = e.lastOpened ? e.lastOpened.replace("T", " ").replace("Z", "Z") : "";
      return `| [[${e.path}]] | ${e.total} | ${e.opens30} | ${e.opens90} | ${e.opens365} | ${e.score} | ${last} |`;
    };

    const { w30, w90, w365 } = this.settings.trendingWeights || DEFAULT_SETTINGS.trendingWeights;

    const header =
      `# Note Open Analytics\n\n` +
      `Generated: ${new Date().toISOString()}\n\n` +
      `Stats folder: \`${this.getStatsFolderVaultPath()}/\`\n\n` +
      `Trending formula: \`opens_30d*${w30} + opens_90d*${w90} + opens_365d*${w365}\`\n\n`;

    const tableHeader =
      `| Note | All-time opens | Opens (30d) | Opens (90d) | Opens (365d) | Trend score | Last opened |\n` +
      `|---|---:|---:|---:|---:|---:|---|\n`;

    const n = this.settings.topN || DEFAULT_SETTINGS.topN;

    const topOpened = topN(stats.byTotal, n).map(fmtRow).join("\n");
    const trending = topN(stats.byTrending, n).map(fmtRow).join("\n");
    const recent = topN(stats.byRecent, n).map(fmtRow).join("\n");

    return (
      header +
      `## Top opened (all-time)\n\n` +
      tableHeader +
      (topOpened || "") +
      `\n\n` +
      `## Trending (30/90/365)\n\n` +
      tableHeader +
      (trending || "") +
      `\n\n` +
      `## Most recently opened\n\n` +
      tableHeader +
      (recent || "") +
      `\n`
    );
  }

  async writeReport() {
    const stats = this.computeStats();
    const md = this.formatReport(stats);
    const reportPath = this.getReportVaultPath();
    await this.writeText(reportPath, md);
  }

  /* -----------------------
     Debounced persistence
     ----------------------- */

  scheduleWrite() {
    if (this._pendingWriteTimer) return;

    const ms = this.settings.writeDebounceMs || DEFAULT_SETTINGS.writeDebounceMs;
    this._pendingWriteTimer = setTimeout(async () => {
      this._pendingWriteTimer = null;

      try {
        await this.ensureStatsFolder();
        await this.writeDb();
        await this.writeReport();
      } catch (e) {
        console.error("[note-open-tracker-plus] Write failed:", e);
      }
    }, ms);
  }

  /* -----------------------
     Settings persistence
     ----------------------- */

  async saveSettings() {
    await this.saveData(this.settings);
    // If folder changed, ensure it exists and re-write outputs there
    await this.ensureStatsFolder();
    if (!this._db) this._db = await this.readDb();
    this.scheduleWrite();
  }
};

class NoteOpenTrackerPlusSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Note Open Tracker Plus" });

    new Setting(containerEl)
      .setName("Stats folder")
      .setDesc("Vault-relative folder where tracker files + report are written.")
      .addText((text) => {
        text
          .setPlaceholder("_Archives/_stats")
          .setValue(this.plugin.settings.statsFolder)
          .onChange(async (value) => {
            this.plugin.settings.statsFolder = value.trim() || DEFAULT_SETTINGS.statsFolder;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Report filename")
      .setDesc("Markdown report name (inside the stats folder).")
      .addText((text) => {
        text
          .setPlaceholder("Note Open Analytics.md")
          .setValue(this.plugin.settings.reportFileName)
          .onChange(async (value) => {
            this.plugin.settings.reportFileName = value.trim() || DEFAULT_SETTINGS.reportFileName;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Write debounce (ms)")
      .setDesc("Higher reduces sync churn; lower updates report faster.")
      .addText((text) => {
        text
          .setPlaceholder("3000")
          .setValue(String(this.plugin.settings.writeDebounceMs))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            this.plugin.settings.writeDebounceMs = Number.isFinite(n) && n >= 500 ? n : DEFAULT_SETTINGS.writeDebounceMs;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Track non-markdown files")
      .setDesc("If enabled, counts opens for any file type (not just .md).")
      .addToggle((toggle) => {
        toggle
          .setValue(!!this.plugin.settings.trackNonMarkdown)
          .onChange(async (value) => {
            this.plugin.settings.trackNonMarkdown = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Enable event log (NDJSON)")
      .setDesc("Writes an append-only event log file. Disable if you want fewer writes or avoid sync conflicts.")
      .addToggle((toggle) => {
        toggle
          .setValue(!!this.plugin.settings.enableEventLog)
          .onChange(async (value) => {
            this.plugin.settings.enableEventLog = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Trending weights")
      .setDesc("Trend score = opens_30d*w30 + opens_90d*w90 + opens_365d*w365")
      .addText((text) => {
        const w = this.plugin.settings.trendingWeights || DEFAULT_SETTINGS.trendingWeights;
        text
          .setPlaceholder("w30=5,w90=2,w365=1")
          .setValue(`w30=${w.w30},w90=${w.w90},w365=${w.w365}`)
          .onChange(async (value) => {
            // parse "w30=5,w90=2,w365=1"
            const parts = value.split(",").map((s) => s.trim());
            const next = { ...DEFAULT_SETTINGS.trendingWeights };
            for (const p of parts) {
              const [k, v] = p.split("=").map((s) => s.trim());
              const n = Number.parseInt(v, 10);
              if (k === "w30" && Number.isFinite(n)) next.w30 = n;
              if (k === "w90" && Number.isFinite(n)) next.w90 = n;
              if (k === "w365" && Number.isFinite(n)) next.w365 = n;
            }
            this.plugin.settings.trendingWeights = next;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Top N rows")
      .setDesc("How many notes to show in each report section.")
      .addText((text) => {
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.topN))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            this.plugin.settings.topN = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.topN;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Paths currently in use")
      .setDesc(
        `DB: ${this.plugin.getDbVaultPath()}\n` +
        `Events: ${this.plugin.getEventsVaultPath()}\n` +
        `Report: ${this.plugin.getReportVaultPath()}`
      );
  }
}
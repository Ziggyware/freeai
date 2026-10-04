export class ValFileEditor {
  constructor(public file) {
    this.file = file;
  }

  get content() {
    return this.file.content;
  }

  setContent(c) {
    this.file.content = c;
    return this;
  }

  // -----------------------------
  // Subdomain support
  // -----------------------------
  getSubdomain() {
    const m = this.file.content.match(/\/\/\s*@subdomain:\s*([a-z0-9-]+)/i);
    return m?.[1];
  }

  setSubdomain(name: string) {
    if (this.getSubdomain()) {
      return this.setContent(
        this.file.content.replace(
          /\/\/\s*@subdomain:\s*[a-z0-9-]+/i,
          `// @subdomain: ${name}`,
        ),
      );
    }
    return this.setContent(`// @subdomain: ${name}\n` + this.file.content);
  }

  // -----------------------------
  // File type inference
  // -----------------------------
  inferKind() {
    const c = this.file.content;

    if (/export\s+default\s+async\s+function\s+handler/.test(c)) {
      return "http-module";
    }
    if (/export\s+async\s+function/.test(c)) {
      return "val-function";
    }
    if (/export\s+const\s+run\s*=/.test(c)) {
      return "scheduled-val";
    }
    if (/export\s+const\s+cron\s*=/.test(c)) {
      return "cron-val";
    }
    if (this.file.name.endsWith(".json")) return "json";
    if (this.file.name.endsWith(".md")) return "markdown";
    return "unknown";
  }

  // -----------------------------
  // Fingerprint (browser crypto)
  // -----------------------------
  async fingerprint() {
    const data = new TextEncoder().encode(this.file.content);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // -----------------------------
  // Save back to workspace
  // -----------------------------
  async save() {
    await fetch("https://ziggyware.vals.workers.dev/workspace/update", {
      method: "POST",
      body: JSON.stringify({
        filePath: this.file.path,
        content: this.file.content,
      }),
    });
  }
}
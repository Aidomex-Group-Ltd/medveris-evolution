import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EmailAdapter, EmailMessage, EmailResult } from "./email.js";

export class LocalMailSink implements EmailAdapter {
  constructor(private readonly directory: string) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    const dir = resolve(process.cwd(), this.directory);
    await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeRecipient = message.to.replace(/[^a-zA-Z0-9@._-]/g, "_");
    const path = join(dir, `${timestamp}-${safeRecipient}-${crypto.randomUUID()}.eml`);
    const content = [
      `To: ${message.to}`,
      `From: medveris-local-sink@localhost`,
      `Subject: ${message.subject}`,
      `Date: ${new Date().toUTCString()}`,
      "",
      message.text,
      "",
    ].join("\n");
    await writeFile(path, content, "utf8");
    return { delivered: true, adapter: "local-mail-sink", detail: path.replace(process.cwd() + "/", "") };
  }
}

export async function makeTemporaryMailDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "medveris-mail-"));
}

/*
 * POM file store — one JSON file per page under a directory.
 * Writes are atomic (write to a temp file in the same directory, then rename),
 * so a crash mid-write never leaves a truncated POM behind.
 * Shared by the HTTP server and the MCP server.
 */
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_POM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pom');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class PomStore {
  constructor(dir = DEFAULT_POM_DIR) {
    this.dir = dir;
  }

  static validName(name) {
    return typeof name === 'string' && NAME_RE.test(name);
  }

  file(name) {
    if (!PomStore.validName(name)) throw badRequest('invalid page name: ' + String(name));
    return path.join(this.dir, name + '.json');
  }

  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const names = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    const pages = [];
    for (const n of names) pages.push(await this.get(n));
    return pages;
  }

  async get(name) {
    let text;
    try {
      text = await fs.readFile(this.file(name), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound('page not found: ' + name);
      throw e;
    }
    const page = JSON.parse(text);
    page.name = name;
    if (!page.elements || typeof page.elements !== 'object') page.elements = {};
    return page;
  }

  async put(name, page) {
    validatePage(page);
    const out = { ...page, name };
    await this.#atomicWrite(this.file(name), out);
    return out;
  }

  async remove(name) {
    try {
      await fs.unlink(this.file(name));
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound('page not found: ' + name);
      throw e;
    }
  }

  async addElement(name, elementName, selector, note) {
    if (typeof elementName !== 'string' || !elementName.trim()) throw badRequest('element name required');
    if (typeof selector !== 'string' || !selector.trim()) throw badRequest('selector required');
    const page = await this.get(name);
    const value = note ? { selector: selector.trim(), note: String(note) } : selector.trim();
    // own property always — a plain assignment of "__proto__" would hit the prototype setter and vanish
    Object.defineProperty(page.elements, elementName.trim(), { value, enumerable: true, writable: true, configurable: true });
    return this.put(name, page);
  }

  async removeElement(name, elementName) {
    const page = await this.get(name);
    if (!Object.prototype.hasOwnProperty.call(page.elements, elementName)) throw notFound('element not found: ' + elementName);
    delete page.elements[elementName];
    return this.put(name, page);
  }

  async #atomicWrite(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // unique, exclusively-created temp name: two concurrent writers never share one
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {}); // best-effort cleanup; the original error is what matters
      throw e;
    }
  }
}

export function validatePage(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) throw badRequest('page must be an object');
  if (page.elements !== undefined && (typeof page.elements !== 'object' || Array.isArray(page.elements))) {
    throw badRequest('elements must be an object of name → selector');
  }
  for (const [k, v] of Object.entries(page.elements || {})) {
    const sel = typeof v === 'string' ? v : v && v.selector;
    if (typeof sel !== 'string' || !sel.trim()) throw badRequest('element "' + k + '" has no selector');
  }
}

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const badRequest = (m) => new StoreError(400, m);
const notFound = (m) => new StoreError(404, m);

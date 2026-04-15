/* Shared helper: load browser-side IIFE onboarding modules under a fresh vm context
 * so we can unit-test them without a real browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONBOARDING_DIR = path.join(__dirname, '..', '..', 'src', 'web', 'onboarding');

/** Make an in-memory localStorage. Pass enabled:false to simulate disabled storage. */
export function makeLocalStorage({ enabled = true } = {}) {
  const store = new Map();
  return {
    getItem(k) {
      if (!enabled) throw new Error('localStorage disabled');
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (!enabled) throw new Error('localStorage disabled');
      store.set(k, String(v));
    },
    removeItem(k) {
      if (!enabled) throw new Error('localStorage disabled');
      store.delete(k);
    },
    _dump() { return Object.fromEntries(store); },
  };
}

/** Minimal DOM element shim sufficient for IIFE modules that render simple markup. */
export function makeElement(tagName = 'div') {
  const el = {
    tagName: tagName.toUpperCase(),
    children: [],
    attrs: {},
    innerHTML: '',
    className: '',
    id: '',
    style: {},
    dataset: {},
    onclick: null,
    _listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    remove() { this.children = []; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
  };
  return el;
}

/** Build a vm sandbox with window/document/fetch/localStorage. */
export function makeSandbox({ fetchImpl, localStorage, url = 'http://localhost:37800/' } = {}) {
  const ls = localStorage || makeLocalStorage();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { language: 'en-US' },
    localStorage: ls,
    location: { href: url, origin: 'http://localhost:37800' },
    fetch: fetchImpl || (async () => { throw new Error('fetch not mocked'); }),
  };
  sandbox.window = sandbox;
  sandbox.document = {
    readyState: 'complete',
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  return vm.createContext(sandbox);
}

/** Load one or more IIFE files into the sandbox sequentially. */
export function loadModules(ctx, files) {
  for (const rel of files) {
    const abs = path.join(ONBOARDING_DIR, rel);
    const src = fs.readFileSync(abs, 'utf-8');
    vm.runInContext(src, ctx, { filename: rel });
  }
}

/** Convenience: inject a minimal LOCALES + t() like index.html would. */
export function installBaseI18n(ctx, locales = { en: {}, zh: {} }) {
  ctx.LOCALES = locales;
  ctx.t = (key, vars) => {
    const locale = ctx.currentLocale || 'en';
    let s = ctx.LOCALES[locale]?.[key] ?? ctx.LOCALES.en?.[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    return s;
  };
}

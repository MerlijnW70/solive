const VOID = new Set(["meta", "link", "br", "img", "input", "hr", "source", "area", "base", "col", "wbr"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };

export class FakeText {
  parent: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

type Child = FakeElement | FakeText;
type Listener = (event: { type: string; target: FakeElement }) => void;

export class FakeElement {
  parent: FakeElement | null = null;
  children: Child[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  focused = 0;
  top = 0;
  readonly classList = {
    add: (...names: string[]) => this.setClasses([...this.classes(), ...names]),
    remove: (...names: string[]) => this.setClasses(this.classes().filter((c) => !names.includes(c))),
    contains: (name: string) => this.classes().includes(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes().includes(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
  };

  constructor(public tagName: string, public owner: FakeDocument, public namespace = "html") {}

  private classes(): string[] {
    return (this.attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
  }

  private setClasses(list: string[]): void {
    this.attrs.set("class", [...new Set(list)].join(" "));
  }

  get elements(): FakeElement[] {
    return this.children.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  get id(): string {
    return this.attrs.get("id") ?? "";
  }

  get hidden(): boolean {
    return this.attrs.has("hidden");
  }

  set hidden(value: boolean) {
    if (value) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }

  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    this.replaceChildren(String(value));
  }

  set innerHTML(_value: string) {
    throw new Error("innerHTML is not a safe sink");
  }

  set outerHTML(_value: string) {
    throw new Error("outerHTML is not a safe sink");
  }

  insertAdjacentHTML(): void {
    throw new Error("insertAdjacentHTML is not a safe sink");
  }

  get offsetWidth(): number {
    return 0;
  }

  get isConnected(): boolean {
    let at: FakeElement | null = this;
    while (at.parent) at = at.parent;
    return at === this.owner.documentElement;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  append(...items: (Child | string)[]): void {
    for (const item of items) {
      const child = typeof item === "string" ? new FakeText(item) : item;
      if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(child: Child): Child {
    this.append(child);
    return child;
  }

  replaceChildren(...items: (Child | string)[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...items);
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this });
  }

  click(): void {
    this.dispatch("click");
  }

  focus(): void {
    this.focused += 1;
  }

  getBoundingClientRect(): { top: number; bottom: number } {
    return { top: this.top, bottom: this.top };
  }

  descendants(): FakeElement[] {
    return this.elements.flatMap((e) => [e, ...e.descendants()]);
  }

  matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("[") && selector.endsWith("]")) return this.attrs.has(selector.slice(1, -1));
    return this.tagName === selector;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((e) => e.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeElement | null {
    let at: FakeElement | null = this;
    while (at && !at.matches(selector)) at = at.parent;
    return at;
  }
}

export class FakeDocument {
  documentElement: FakeElement;
  created: FakeElement[] = [];

  constructor() {
    this.documentElement = new FakeElement("html", this);
  }

  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag.toLowerCase(), this);
    this.created.push(el);
    return el;
  }

  createElementNS(namespace: string, tag: string): FakeElement {
    const el = new FakeElement(tag, this, namespace);
    this.created.push(el);
    return el;
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.descendants().find((e) => e.id === id) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }
}

export function decode(text: string): string {
  return text.replace(/&(#?[a-z0-9]+);/gi, (whole: string, name: string) => ENTITIES[name] ?? whole);
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTR = /([^\s=>/]+)(?:="([^"]*)")?/g;

export function parse(html: string): FakeDocument {
  const doc = new FakeDocument();
  const body = html.replace(/^<!doctype html>\s*/i, "");
  const stack: FakeElement[] = [];
  let at = 0;
  let root: FakeElement | null = null;
  for (const match of body.matchAll(TAG)) {
    const text = body.slice(at, match.index);
    if (text && stack.length) stack[stack.length - 1]?.append(decode(text));
    at = match.index + match[0].length;
    const [, closing, rawName = "", rawAttrs = "", selfClosing] = match;
    const name = rawName;
    if (closing) {
      const open = stack.pop();
      if (open?.tagName !== name) throw new Error("mismatched </" + name + "> for <" + open?.tagName + ">");
      continue;
    }
    const el = name === "html" ? doc.documentElement : new FakeElement(name, doc);
    for (const a of rawAttrs.matchAll(ATTR)) el.attrs.set(a[1] ?? "", decode(a[2] ?? ""));
    if (name === "html") root = el;
    else stack[stack.length - 1]?.append(el);
    if (!selfClosing && !VOID.has(name)) stack.push(el);
  }
  if (stack.length || !root) throw new Error("unclosed elements: " + stack.map((e) => e.tagName).join(","));
  return doc;
}

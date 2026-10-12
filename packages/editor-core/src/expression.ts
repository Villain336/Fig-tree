/**
 * Arithmetic in number fields: `12*2`, `100/3`, `(8+4)*2`, `-4`, `50%` of the
 * current value, and relative edits starting with an operator applied to
 * the current value (`+10`, `*2`). A small recursive-descent parser; no
 * `eval`.
 */

export class ExpressionError extends Error {}

/**
 * Evaluates `input`. `current` is the field's value before the edit (used
 * by relative forms and `%`); null when the field shows a mixed value.
 */
export function evaluateExpression(input: string, current: number | null = null): number {
  const src = input.trim().replace(/,/g, ".");
  if (src === "") throw new ExpressionError("empty");
  // Relative edit: "+10" adds, "*2" multiplies, "/2" divides the current value ("-4" is a plain negative number).
  if (current !== null && /^[+*/×÷]/.test(src)) return evaluateExpression(`${current}${src}`, current);
  const p = new Parser(src, current);
  const v = p.expression();
  p.skip();
  if (p.pos < src.length) throw new ExpressionError(`unexpected "${src[p.pos]}"`);
  if (!Number.isFinite(v)) throw new ExpressionError("not a finite number");
  return v;
}

class Parser {
  pos = 0;
  constructor(
    readonly src: string,
    readonly current: number | null,
  ) {}

  skip(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  peek(): string {
    this.skip();
    return this.src[this.pos] ?? "";
  }

  expression(): number {
    let v = this.term();
    for (;;) {
      const c = this.peek();
      if (c === "+") {
        this.pos++;
        v += this.term();
      } else if (c === "-") {
        this.pos++;
        v -= this.term();
      } else return v;
    }
  }

  term(): number {
    let v = this.factor();
    for (;;) {
      const c = this.peek();
      if (c === "*" || c === "×") {
        this.pos++;
        v *= this.factor();
      } else if (c === "/" || c === "÷") {
        this.pos++;
        const d = this.factor();
        if (d === 0) throw new ExpressionError("division by zero");
        v /= d;
      } else return v;
    }
  }

  factor(): number {
    const c = this.peek();
    if (c === "-") {
      this.pos++;
      return -this.factor();
    }
    if (c === "+") {
      this.pos++;
      return this.factor();
    }
    let v: number;
    if (c === "(") {
      this.pos++;
      v = this.expression();
      if (this.peek() !== ")") throw new ExpressionError("missing )");
      this.pos++;
    } else {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.src.slice(this.pos));
      if (!m) throw new ExpressionError(c ? `unexpected "${c}"` : "unexpected end");
      this.pos += m[0].length;
      v = Number(m[0]);
      // Units the fields already imply are accepted and ignored.
      const unit = /^\s*(px|deg|°)/i.exec(this.src.slice(this.pos));
      if (unit) this.pos += unit[0].length;
    }
    if (this.peek() === "%") {
      this.pos++;
      if (this.current === null) throw new ExpressionError("% needs a current value");
      v = (this.current * v) / 100;
    }
    return v;
  }
}

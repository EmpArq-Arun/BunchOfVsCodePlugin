import {
  bareTypeName,
  inMainFile,
  typeName,
  walk,
  type AstNode,
  type Located,
  type Span,
} from './ast.js';
import type { Severity } from './constructs.js';
import type { StructureModel } from './structure.js';

/**
 * Statement-level constructs — the Rosetta lens proper.
 *
 * P1 answers "what is unfamiliar about this class". This answers the harder and
 * more useful question: "what is this *line* doing that it does not look like it
 * is doing". Almost everything that surprises a C engineer in C++ is invisible
 * at the call site — a destructor that runs at a closing brace, a temporary
 * built and torn down inside one statement, a guard variable behind a static, an
 * index operator that is a function call.
 *
 * Each finding has three parts, and the third is the one that does the teaching:
 * what you see, what the compiler builds, and what you would have written in C
 * to get the same machine behaviour.
 */

export interface RosettaFinding {
  construct: string;
  severity: Severity;
  title: string;
  /** What the compiler materialises here. */
  emits: string;
  /** The C you would have written for the same behaviour. */
  cEquivalent: string;
  span: Span;
  /** Mangled name where one is available — the join to the binary plane at P5. */
  mangled?: string;
}

function has(node: AstNode, key: string): boolean {
  return node[key] === true;
}

function ctorTypeOf(node: AstNode): string {
  return bareTypeName(typeName(node)) || 'the object';
}

/**
 * Does this type have a destructor with observable effect? Answered from the
 * structure model when one is loaded, because clang's JSON does not say so at
 * the construction site. Without a model the answer is "assume yes and say so",
 * which errs toward showing the reader something real rather than hiding it.
 */
function destructorEvidence(
  typeQual: string,
  structure: StructureModel | undefined,
): { hasDtor: boolean; certain: boolean } {
  if (!structure) {
    return { hasDtor: true, certain: false };
  }
  const bare = bareTypeName(typeQual);
  const short = bare.split('::').pop() ?? bare;
  const t = structure.types.find((x) => x.qualifiedName === bare || x.name === short);
  if (!t) {
    return { hasDtor: true, certain: false };
  }
  return { hasDtor: t.methods.some((m) => m.isDestructor), certain: true };
}

/** Is `method` on the receiver type virtual, according to the structure model? */
function isVirtualMethod(
  receiverType: string,
  method: string,
  structure: StructureModel | undefined,
): boolean | undefined {
  if (!structure) {
    return undefined;
  }
  const bare = bareTypeName(receiverType);
  const short = bare.split('::').pop() ?? bare;
  const t = structure.types.find((x) => x.qualifiedName === bare || x.name === short);
  if (!t) {
    return undefined;
  }
  const m = t.methods.find((x) => x.name === method);
  return m ? m.isVirtual : undefined;
}

/** Receiver type of a member call: the type of the object the MemberExpr hangs off. */
function receiverTypeOf(callNode: AstNode): { type: string; method: string } | undefined {
  const member = callNode.inner?.find((n) => n.kind === 'MemberExpr');
  if (!member || typeof member.name !== 'string') {
    return undefined;
  }
  const receiver = member.inner?.[0];
  if (!receiver) {
    return undefined;
  }
  // An lvalue receiver is often wrapped in an ImplicitCastExpr; the type on the
  // outermost node is still the receiver's type.
  return { type: typeName(receiver), method: member.name };
}

/**
 * Captures of a lambda.
 *
 * clang leaves the capture `FieldDecl`s *unnamed* — they carry only a type — so
 * the names have to come from the `DeclRefExpr` capture-initialiser siblings of
 * the `LambdaExpr` itself, where `referencedDecl.name` holds the captured
 * variable. Reading names off the fields returns nothing, which looks like a
 * captureless lambda and would say exactly the wrong thing about lifetime.
 */
function lambdaCaptures(node: AstNode): { name: string; type: string; byRef: boolean }[] {
  const record = node.inner?.find((n) => n.kind === 'CXXRecordDecl');
  const fields = (record?.inner ?? []).filter((n) => n.kind === 'FieldDecl');
  const names = (node.inner ?? [])
    .filter((n) => n.kind === 'DeclRefExpr')
    .map((n) => (n.referencedDecl as AstNode | undefined)?.name)
    .filter((n): n is string => typeof n === 'string');

  return fields.map((f, i) => {
    const type = typeName(f);
    return { name: names[i] ?? `capture ${i + 1}`, type, byRef: type.includes('&') };
  });
}

export interface DetectOptions {
  mainFile: string;
  structure?: StructureModel;
}

export function detectRosetta(roots: AstNode[], opts: DetectOptions): RosettaFinding[] {
  const located = walk(roots, opts.mainFile).filter((l) => inMainFile(l, opts.mainFile));
  const out: RosettaFinding[] = [];
  const emit = (l: Located, f: Omit<RosettaFinding, 'span'>) => out.push({ ...f, span: l.span });

  for (const l of located) {
    const n = l.node;
    switch (n.kind) {
      // --- object lifetime -------------------------------------------------
      case 'CXXConstructExpr': {
        const type = ctorTypeOf(n);
        const { hasDtor, certain } = destructorEvidence(typeName(n), opts.structure);
        emit(l, {
          construct: 'object_construction',
          severity: 'new',
          title: `Constructs ${type}`,
          emits:
            `A call to ${type}'s constructor. ` +
            (hasDtor
              ? `Its destructor is called automatically when the enclosing scope ends — including on every early ` +
                `return and every path an exception takes${certain ? '' : ' (destructor presence not confirmed: no structure model loaded)'}.`
              : 'This type has no destructor, so construction is the only cost.'),
          cEquivalent:
            hasDtor
              ? `${type}_init(&obj, ...) at this point, and ${type}_deinit(&obj) at every single exit from the ` +
                'function. The C++ version cannot forget one, which is the entire point of RAII.'
              : `${type}_init(&obj, ...). No cleanup needed.`,
        });
        break;
      }

      case 'ExprWithCleanups': {
        if (!has(n, 'cleanupsHaveSideEffects')) {
          break;
        }
        emit(l, {
          construct: 'temporary_destroyed',
          severity: 'trap',
          title: 'A destructor runs at the end of this statement',
          emits:
            'A temporary object was created inside this expression and is destroyed at the closing semicolon. ' +
            'Nothing in the source text marks either event.',
          cEquivalent:
            'A local struct you built, passed to something, and freed on the next line. Here both the build and ' +
            'the free are implied. If you took a pointer or reference to that temporary and kept it, it is ' +
            'dangling from the semicolon onward.',
        });
        break;
      }

      case 'MaterializeTemporaryExpr': {
        emit(l, {
          construct: 'materialised_temporary',
          severity: 'new',
          title: `Temporary ${bareTypeName(typeName(n)) || 'object'} given storage`,
          emits:
            'A value that had no address is given one, because something needs to bind a reference to it. Its ' +
            'lifetime is the enclosing full-expression, unless bound to a reference that extends it.',
          cEquivalent:
            'Assigning a returned struct to an unnamed local so you can take its address. C makes you name it; ' +
            'C++ does it silently, and the lifetime rules are where the surprises live.',
        });
        break;
      }

      // --- storage ---------------------------------------------------------
      case 'VarDecl': {
        if (n.storageClass !== 'static') {
          break;
        }
        const local = typeof n.mangledName === 'string' && n.mangledName.startsWith('_ZZ');
        if (!local) {
          break;
        }
        emit(l, {
          construct: 'function_local_static',
          severity: 'trap',
          title: `Function-local static: ${String(n.name ?? '')}`,
          emits:
            'One object for the whole program in .data or .bss, plus a guard variable and a call to ' +
            '__cxa_guard_acquire on every entry to check whether initialisation has already happened. ' +
            '-fno-threadsafe-statics removes the guard when you know it is single-threaded.',
          cEquivalent:
            'A file-scope static plus a hand-written `if (!initialised)` flag. The C++ version adds thread safety ' +
            'you may not need and are paying for on every call.',
          ...(typeof n.mangledName === 'string' ? { mangled: n.mangledName } : {}),
        });
        break;
      }

      // --- dispatch and calls ----------------------------------------------
      case 'CXXMemberCallExpr': {
        const recv = receiverTypeOf(n);
        if (!recv) {
          break;
        }
        const virt = isVirtualMethod(recv.type, recv.method, opts.structure);
        if (virt !== true) {
          break;
        }
        emit(l, {
          construct: 'virtual_call_site',
          severity: 'new',
          title: `Virtual call: ${bareTypeName(recv.type)}::${recv.method}`,
          emits:
            'Load the vptr from the object, load the slot from the vtable in flash, branch. Not inlinable, and ' +
            'the target depends on the dynamic type rather than what is written here.',
          cEquivalent:
            'obj->vtbl->method(obj, ...) — the pattern you write by hand in a HAL. Use the Flow lens on this ' +
            'line to see the full candidate set.',
        });
        break;
      }

      case 'CXXOperatorCallExpr': {
        emit(l, {
          construct: 'operator_call',
          severity: 'new',
          title: 'This operator is a function call',
          emits:
            'An ordinary call to an overloaded operator. The syntax looks like indexing or arithmetic; the ' +
            'codegen is a call, with whatever cost that function has.',
          cEquivalent:
            'buffer_at(&buf, i) written as buf[i]. Identical machine code, but at the call site you can no ' +
            'longer tell by looking whether anything expensive happens.',
        });
        break;
      }

      // --- allocation ------------------------------------------------------
      case 'CXXNewExpr': {
        const allocator = (n.operatorNewDecl as AstNode | undefined)?.name ?? 'operator new';
        emit(l, {
          construct: 'heap_allocation',
          severity: 'trap',
          title: `Heap allocation via ${String(allocator)}`,
          emits:
            'A call to the allocator, then the constructor. Pulls malloc and the terminate handler into the ' +
            'image, and can fail or fragment on a part with no MMU.',
          cEquivalent:
            'malloc followed by an init call, with the null check you would have written. Worth asking whether ' +
            'a static pool or a stack object would do instead — on most firmware it would.',
        });
        break;
      }

      case 'CXXDeleteExpr': {
        emit(l, {
          construct: 'heap_release',
          severity: 'new',
          title: has(n, 'isArrayForm') ? 'Array delete' : 'Delete',
          emits:
            'Destructor first, then the deallocator. If the static type has a non-virtual destructor and the ' +
            'object is really a derived type, only the base part is destroyed.',
          cEquivalent: 'A deinit call followed by free. The ordering is the same; here it is implicit.',
        });
        break;
      }

      // --- exceptions and RTTI ---------------------------------------------
      case 'CXXThrowExpr': {
        emit(l, {
          construct: 'throw',
          severity: 'trap',
          title: 'Throws',
          emits:
            'Allocates an exception object (usually on the heap), then unwinds. Enabling exceptions at all adds ' +
            '.ARM.extab/.ARM.exidx unwind tables and pulls in the personality routine and much of libsupc++.',
          cEquivalent:
            'Returning an error code and checking it at every level. Compare the image size with -fno-exceptions ' +
            'to see what this costs on your part.',
        });
        break;
      }

      case 'CXXTryStmt': {
        emit(l, {
          construct: 'try_block',
          severity: 'new',
          title: 'Try block',
          emits:
            'Landing pads and unwind table entries. On the non-throwing path the runtime cost is close to zero; ' +
            'the cost is ROM, not cycles.',
          cEquivalent: 'A goto-based cleanup chain, or checking a return code after every call.',
        });
        break;
      }

      case 'CXXDynamicCastExpr':
      case 'CXXTypeidExpr': {
        emit(l, {
          construct: 'rtti_use',
          severity: 'trap',
          title: n.kind === 'CXXTypeidExpr' ? 'typeid' : 'dynamic_cast',
          emits:
            'Reads the typeinfo record (_ZTI) and the type name string (_ZTS) from .rodata, and pulls ' +
            '__dynamic_cast out of libsupc++. -fno-rtti removes all of it, and this line with it.',
          cEquivalent:
            'A type tag field in the struct and a switch on it. Cheaper, and explicit about which types exist.',
        });
        break;
      }

      // --- syntax that desugars --------------------------------------------
      case 'LambdaExpr': {
        const captures = lambdaCaptures(n);
        const byRef = captures.filter((c) => c.byRef);
        emit(l, {
          construct: 'lambda',
          severity: byRef.length > 0 ? 'trap' : 'new',
          title:
            captures.length > 0
              ? `Lambda capturing ${captures.map((c) => c.name).join(', ')}`
              : 'Captureless lambda',
          emits:
            captures.length > 0
              ? `An unnamed struct with one member per capture (${captures
                  .map((c) => `${c.name}: ${c.type}`)
                  .join(', ')}) and an operator().` +
                (byRef.length > 0
                  ? ` ${byRef.map((c) => c.name).join(', ')} ${byRef.length === 1 ? 'is' : 'are'} captured by ` +
                    'reference — the closure holds a raw reference and dangles if it outlives the referent.'
                  : '')
              : 'An unnamed struct with no members and an operator(). Convertible to a plain function pointer, ' +
                'so it can be used as a C callback with no wrapper.',
          cEquivalent:
            captures.length > 0
              ? 'A context struct you fill in, plus a function taking that struct as its first argument — the ' +
                'callback-with-userdata pattern, written for you. By-reference captures are pointers into the ' +
                'caller frame, with the same lifetime rules you already apply to those.'
              : 'A plain function. Nothing extra is generated.',
        });
        break;
      }

      case 'CXXForRangeStmt': {
        emit(l, {
          construct: 'range_for',
          severity: 'familiar',
          title: 'Range-based for',
          emits:
            'Expands to a hidden __range reference plus begin/end iterators and an ordinary loop. On a raw array ' +
            'the iterators are pointers and the result is the loop you would have written.',
          cEquivalent:
            'for (T *it = arr; it != arr + n; ++it). The count cannot go stale, which is the one real difference.',
        });
        break;
      }

      case 'DecompositionDecl': {
        emit(l, {
          construct: 'structured_binding',
          severity: 'familiar',
          title: 'Structured binding',
          emits:
            'One hidden object holding the result, with each name an alias for a member of it. No copies beyond ' +
            'the one object.',
          cEquivalent:
            'struct S s = read(); then using s.a and s.b. Same code; the intermediate just has no name you can type.',
        });
        break;
      }

      case 'CoawaitExpr':
      case 'CoyieldExpr':
      case 'CoreturnStmt': {
        emit(l, {
          construct: 'coroutine_suspend',
          severity: 'trap',
          title: n.kind === 'CoreturnStmt' ? 'co_return' : 'Suspension point',
          emits:
            'Everything live across this point is stored in a coroutine frame, allocated with operator new unless ' +
            'the compiler can prove the frame does not escape. On a part with no heap this is a hard failure, not ' +
            'a slow path.',
          cEquivalent:
            'A hand-written state machine with an explicit context struct you allocated yourself. You knew where ' +
            'that struct lived; here you have to check whether the allocation was elided.',
        });
        break;
      }

      case 'ImplicitCastExpr': {
        const castKind = n.castKind;
        if (castKind !== 'UserDefinedConversion' && castKind !== 'ConstructorConversion') {
          break;
        }
        emit(l, {
          construct: 'implicit_conversion',
          severity: 'trap',
          title: `Implicit conversion to ${bareTypeName(typeName(n)) || 'another type'}`,
          emits:
            'A constructor or conversion operator called with nothing in the source to show it. This is where ' +
            'unintended copies and unintended allocations hide.',
          cEquivalent:
            'An explicit conversion call you would have had to write. C would not have let this happen silently.',
        });
        break;
      }

      default:
        break;
    }
  }

  return dedupe(out);
}

/**
 * Collapse findings of the same construct on the same line.
 *
 * A single statement legitimately produces several AST nodes of the same kind —
 * `out[0] = scratch[0]` is two operator calls — and reporting the line twice
 * teaches nothing the first report did not.
 */
function dedupe(findings: RosettaFinding[]): RosettaFinding[] {
  const seen = new Set<string>();
  const out: RosettaFinding[] = [];
  for (const f of findings) {
    const key = `${f.construct}|${f.span.beginLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out.sort((a, b) => a.span.beginLine - b.span.beginLine || a.span.beginCol - b.span.beginCol);
}

export function rosettaByLine(findings: RosettaFinding[]): Map<number, RosettaFinding[]> {
  const out = new Map<number, RosettaFinding[]>();
  for (const f of findings) {
    (out.get(f.span.beginLine) ?? out.set(f.span.beginLine, []).get(f.span.beginLine)!).push(f);
  }
  return out;
}

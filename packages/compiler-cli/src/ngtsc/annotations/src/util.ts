/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Expression, R3DependencyMetadata, R3ResolvedDependencyType, WrappedNodeExpr} from '@angular/compiler';
import * as ts from 'typescript';

import {Decorator, ReflectionHost} from '../../host';
import {AbsoluteReference, Reference} from '../../metadata';

export function getConstructorDependencies(
    clazz: ts.ClassDeclaration, reflector: ReflectionHost,
    isCore: boolean): R3DependencyMetadata[] {
  const useType: R3DependencyMetadata[] = [];
  const ctorParams = reflector.getConstructorParameters(clazz) || [];
  ctorParams.forEach((param, idx) => {
    let tokenExpr = param.type;
    let optional = false, self = false, skipSelf = false, host = false;
    let resolved = R3ResolvedDependencyType.Token;
    (param.decorators || []).filter(dec => isCore || isAngularCore(dec)).forEach(dec => {
      if (dec.name === 'Inject') {
        if (dec.args === null || dec.args.length !== 1) {
          throw new Error(`Unexpected number of arguments to @Inject().`);
        }
        tokenExpr = dec.args[0];
      } else if (dec.name === 'Optional') {
        optional = true;
      } else if (dec.name === 'SkipSelf') {
        skipSelf = true;
      } else if (dec.name === 'Self') {
        self = true;
      } else if (dec.name === 'Host') {
        host = true;
      } else if (dec.name === 'Attribute') {
        if (dec.args === null || dec.args.length !== 1) {
          throw new Error(`Unexpected number of arguments to @Attribute().`);
        }
        tokenExpr = dec.args[0];
        resolved = R3ResolvedDependencyType.Attribute;
      } else {
        throw new Error(`Unexpected decorator ${dec.name} on parameter.`);
      }
    });
    if (tokenExpr === null) {
      throw new Error(
          `No suitable token for parameter ${param.name || idx} of class ${clazz.name!.text}`);
    }
    if (ts.isIdentifier(tokenExpr)) {
      const importedSymbol = reflector.getImportOfIdentifier(tokenExpr);
      if (importedSymbol !== null && importedSymbol.from === '@angular/core') {
        switch (importedSymbol.name) {
          case 'ChangeDetectorRef':
            resolved = R3ResolvedDependencyType.ChangeDetectorRef;
            break;
          case 'ElementRef':
            resolved = R3ResolvedDependencyType.ElementRef;
            break;
          case 'Injector':
            resolved = R3ResolvedDependencyType.Injector;
            break;
          case 'TemplateRef':
            resolved = R3ResolvedDependencyType.TemplateRef;
            break;
          case 'ViewContainerRef':
            resolved = R3ResolvedDependencyType.ViewContainerRef;
            break;
          default:
            // Leave as a Token or Attribute.
        }
      }
    }
    const token = new WrappedNodeExpr(tokenExpr);
    useType.push({token, optional, self, skipSelf, host, resolved});
  });
  return useType;
}

export function referenceToExpression(ref: Reference, context: ts.SourceFile): Expression {
  const exp = ref.toExpression(context);
  if (exp === null) {
    throw new Error(`Could not refer to ${ts.SyntaxKind[ref.node.kind]}`);
  }
  return exp;
}

export function isAngularCore(decorator: Decorator): boolean {
  return decorator.import !== null && decorator.import.from === '@angular/core';
}

/**
 * Unwrap a `ts.Expression`, removing outer type-casts or parentheses until the expression is in its
 * lowest level form.
 *
 * For example, the expression "(foo as Type)" unwraps to "foo".
 */
export function unwrapExpression(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}

function expandForwardRef(arg: ts.Expression): ts.Expression|null {
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) {
    return null;
  }

  const body = arg.body;
  // Either the body is a ts.Expression directly, or a block with a single return statement.
  if (ts.isBlock(body)) {
    // Block body - look for a single return statement.
    if (body.statements.length !== 1) {
      return null;
    }
    const stmt = body.statements[0];
    if (!ts.isReturnStatement(stmt) || stmt.expression === undefined) {
      return null;
    }
    return stmt.expression;
  } else {
    // Shorthand body - return as an expression.
    return body;
  }
}

/**
 * Possibly resolve a forwardRef() expression into the inner value.
 *
 * @param node the forwardRef() expression to resolve
 * @param reflector a ReflectionHost
 * @returns the resolved expression, if the original expression was a forwardRef(), or the original
 * expression otherwise
 */
export function unwrapForwardRef(node: ts.Expression, reflector: ReflectionHost): ts.Expression {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) ||
      node.arguments.length !== 1) {
    return node;
  }
  const expr = expandForwardRef(node.arguments[0]);
  if (expr === null) {
    return node;
  }
  const imp = reflector.getImportOfIdentifier(node.expression);
  if (imp === null || imp.from !== '@angular/core' || imp.name !== 'forwardRef') {
    return node;
  } else {
    return expr;
  }
}

/**
 * A foreign function resolver for `staticallyResolve` which unwraps forwardRef() expressions.
 *
 * @param ref a Reference to the declaration of the function being called (which might be
 * forwardRef)
 * @param args the arguments to the invocation of the forwardRef expression
 * @returns an unwrapped argument if `ref` pointed to forwardRef, or null otherwise
 */
export function forwardRefResolver(
    ref: Reference<ts.FunctionDeclaration|ts.MethodDeclaration>,
    args: ts.Expression[]): ts.Expression|null {
  if (!(ref instanceof AbsoluteReference) || ref.moduleName !== '@angular/core' ||
      ref.symbolName !== 'forwardRef' || args.length !== 1) {
    return null;
  }
  return expandForwardRef(args[0]);
}
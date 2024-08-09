import ts, {
    ArrowFunction,
    ClassDeclaration, Expression, FunctionTypeNode, Identifier,
    MethodDeclaration,
    Node, NodeArray,
    ObjectLiteralExpression, ParameterDeclaration,
    PropertyAccessExpression,
    SyntaxKind, TypeNode, TypeReference, TypeReferenceNode
} from 'typescript';
import {FileTransformRun, TextPatch} from "./transformerUtil";
import {transformerVersion} from "./index";
import {visitReplace} from "restfuncs-common";
import {diag_sourceLocation} from "restfuncs-server/ServerSession";


/**
 * Transformer that adds the following statement to the method body (like in readme.md#how-it-works)
 * <code><pre>
 * static getRemoteMethodsMeta() {
 *     ....
 * }
 * </pre></code>
 */
export class AddRemoteMethodsMeta extends FileTransformRun {
    /**
     * Should this transformer squeeze the added declarations (result) into one line to keep the line numbers in the source text intact ?
     * Prevents the [broken source maps bug](https://github.com/bogeeee/restfuncs/issues/2)
     */
    static squeezeDeclarationsIntoOneLine = true;
    diagnosis_currentClass_instanceMethodsSeen?: Set<string>;
    currentClass_instanceMethodsMeta?: Record<string, ObjectLiteralExpression>; // The {...} that should be added below... see example in readme.md
    result = new TextPatch();

    /* Visitor Function */
    visit(node: Node): Node {
        if (node.kind === SyntaxKind.MethodDeclaration) { // @remote ?
            const methodDeclaration = (node as MethodDeclaration)
            if(this.getChilds(methodDeclaration).some(n => n.kind == SyntaxKind.StaticKeyword)) { // static ?
                return node; // no special handling
            }
            if(this.getParent().kind !== SyntaxKind.ClassDeclaration) { // Method not under a class (i.e. an anonymous object ?}
                return node; // no special handling
            }

            const methodName = (methodDeclaration.name as any).escapedText;
            try {
                let remoteDecorator = this.getChilds(methodDeclaration).find(d => d.kind === SyntaxKind.Decorator);
                if (!remoteDecorator) { // no @remote found ?
                    return node; // no special handling
                }

                // Diagnosis: Check for overloads:
                if(this.diagnosis_currentClass_instanceMethodsSeen?.has(methodName)) { // Seen twice ?
                    throw new Error(`@remote methods cannot have multiple/overloaded signatures: ${methodName}. Location: ${this.diag_sourceLocation(node)}`) // TODO: add diagnosis
                }

                this.currentClass_instanceMethodsMeta![methodName] = this.createMethodMetaExpression(methodDeclaration, methodName) // create the code:
            }
            finally {
                this.diagnosis_currentClass_instanceMethodsSeen!.add(methodName);
            }

            return node;
        }
        else if(node.kind === SyntaxKind.ClassDeclaration) {
            this.diagnosis_currentClass_instanceMethodsSeen = new Set()
            this.currentClass_instanceMethodsMeta = {}
            try {
                let result = this.visitChilds(node) as ClassDeclaration

                if(Object.keys(this.currentClass_instanceMethodsMeta).length > 0) { // Current class has @remote methods ?
                    // *** Create the "getRemoteMethodsMeta()" function and add a patch for the source file to the result: ***
                    let methodDeclarationSourceText = this.create_static_getRemoteMethodsMeta_expression();
                    if(AddRemoteMethodsMeta.squeezeDeclarationsIntoOneLine) {
                        methodDeclarationSourceText = '/* code squeezed into one line to keep line numbers intact. You can output it prettier by setting "pretty":true in the plugin configuration in tsconfig.json */' + methodDeclarationSourceText.replaceAll("\n","");
                    }
                    methodDeclarationSourceText = ";" + methodDeclarationSourceText; // prepend with semicolon to prevent syntax error if there's stuff in the same line of the closing bracket

                    this.result.patches.push({position: node.end -1 /* insert before the closing bracket*/, contentToInsert: methodDeclarationSourceText}); // Add patch to result
                }


                return result
            }
            finally {
                this.currentClass_instanceMethodsMeta = undefined
                this.diagnosis_currentClass_instanceMethodsSeen = undefined
            }
        }
        else {
            return this.visitChilds(node);
        }
    }


    /**
     * Crates the following expression like in readme.md#how-it-works
     * <code><pre>
     * {
     *     arguments: {
     *        ...
     *     }
     *     jsDoc: {
     *         ...
     *     }
     * }
     * </pre></code>
     *
     * @param methodName
     * @private
     */
    createMethodMetaExpression(node: MethodDeclaration, methodName: string) {
        // Note: These `factory.create...` "pyramids of doom", which you see all along in this method's code, were mostly created by copying the example code from readme.md#how-it-works through the [AST viewer tool](https://ts-ast-viewer.com/)
        // TODO: Argh, we don't need these "pyramids of doom" any more all over this file, because at the end, the file content gets patched wit a string content (and not an AST). We could just return a string with the source code while using this.nodeToString(...)
        const factory = this.context.factory;

        const arguments_typiaFuncs:Record<string, PropertyAccessExpression> = {
            /**
             * typia.validateEquals
             */
            validateEquals: factory.createPropertyAccessExpression(
                factory.createIdentifier("typia"),
                factory.createIdentifier("validateEquals")
            ),
            "validatePrune": factory.createPropertyAccessExpression(factory.createPropertyAccessExpression(
                factory.createIdentifier("typia"),
                factory.createIdentifier("misc")
            ), factory.createIdentifier("validatePrune"))
        }
        const result_typiaFuncs = {...arguments_typiaFuncs};

        // Clone parameters and convert all ParameterDeclarations to NamedTupleMembers (They look the same in the .ts code but are of a different SyntaxKind).
        const methodParametersWithPlaceholders = structuredClone(node.parameters).map(paramDecl => {
            return factory.createNamedTupleMember(
                paramDecl.dotDotDotToken,
                paramDecl.name as Identifier,
                paramDecl.questionToken,
                paramDecl.type || factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
            )
        });

        // ** Callbacks: **
        // Replace the (arrow-) function declarations inside methodParametersWithPlaceholders with "_callback" placeholders and create the callbackDeclarations array which contains the
        // declarations like in readme.md saying "[{ // here for the `someCallbackFn: (p:number) => Promise<string>` declaration ...}]"
        let callbackDeclarations: ObjectLiteralExpression[] = [];
        visitReplace(methodParametersWithPlaceholders, (value, visitChilds, context) => {
            if (value && (value as Node).kind === SyntaxKind.FunctionType) { // found an arrow-style function type declaration ?
                const functionTypeNode = value as FunctionTypeNode;
                // **** Create the callbackDeclaration like `{ // here for the `someCallbackFn: (p:number) => Promise<string>` declaration...}` in readme.md ****
                // Create argumentsDeclaration. `{ validateEquals: ..., validatePrune: ...}` like in readme.md
                const argumentsDeclaration = factory.createObjectLiteralExpression(
                    Object.keys(arguments_typiaFuncs).map((typiaFnName) => // for validateEquals + validatePrune
                        factory.createPropertyAssignment(
                            factory.createIdentifier(typiaFnName),
                            factory.createArrowFunction(
                                undefined,
                                undefined,
                                [factory.createParameterDeclaration(
                                    undefined,
                                    undefined,
                                    factory.createIdentifier("args"),
                                    undefined,
                                    factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                                    undefined
                                )],
                                undefined,
                                factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                                factory.createCallExpression(arguments_typiaFuncs[typiaFnName],
                                    [factory.createTupleTypeNode(structuredClone(functionTypeNode.parameters).map(paramDecl => { // Must convert ParameterDeclarations to NamedTupleMembers (They look the same in the .ts code but are of a different SyntaxKind).
                                        return factory.createNamedTupleMember(
                                            paramDecl.dotDotDotToken,
                                            paramDecl.name as Identifier,
                                            paramDecl.questionToken,
                                            paramDecl.type || factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
                                        )
                                    }))],
                                    [factory.createIdentifier("args")]
                                )
                            )
                        )),
                    true
                );
                // Create awaitedResultDeclaration. `awaitedResult = ...` like in readme.md:
                let awaitedResultDeclaration: Expression;
                if (functionTypeNode.type.kind == SyntaxKind.VoidKeyword) { // Return type is (sync) void ?
                    awaitedResultDeclaration = factory.createIdentifier("undefined");
                } else {
                    if (functionTypeNode.type.kind == SyntaxKind.TypeReference && ((functionTypeNode.type as TypeReferenceNode).typeName as any).escapedText == "Promise") { // Returns via Promise
                        // Validity check:
                        if (!(functionTypeNode.type as TypeReferenceNode).typeArguments || (functionTypeNode.type as TypeReferenceNode).typeArguments!.length != 1) {
                            throw new Error(`A callback function, declared in ${methodName}'s parameters, returns a Promise with an invalid number of type arguments. Location: ${this.diag_sourceLocation(node)}`);
                        }

                        const awaitedType: TypeReferenceNode = (functionTypeNode.type as TypeReferenceNode).typeArguments![0] as TypeReferenceNode;

                        awaitedResultDeclaration = factory.createObjectLiteralExpression(
                            Object.keys(result_typiaFuncs).map((typiaFnName) => // for validateEquals + validatePrune
                                factory.createPropertyAssignment(
                                    factory.createIdentifier(typiaFnName),
                                    factory.createArrowFunction(
                                        undefined,
                                        undefined,
                                        [factory.createParameterDeclaration(
                                            undefined,
                                            undefined,
                                            factory.createIdentifier("value"),
                                            undefined,
                                            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                                            undefined
                                        )],
                                        undefined,
                                        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                                        factory.createCallExpression(arguments_typiaFuncs[typiaFnName],
                                            [awaitedType],
                                            [factory.createIdentifier("value")]
                                        )
                                    )
                                )),
                            true
                        );
                    } else {
                        throw new Error(`A callback function, declared in ${methodName}'s parameters, has neither void nor a Promise as return type. Location: ${this.diag_sourceLocation(node)}`);
                    }
                }

                // Compose result:
                const callbackDeclaration = factory.createObjectLiteralExpression(
                    [
                        // arguments: {...}
                        factory.createPropertyAssignment(
                            factory.createIdentifier("arguments"),
                            argumentsDeclaration
                        ),

                        // awaitedResult: {...}
                        factory.createPropertyAssignment(
                            factory.createIdentifier("awaitedResult"),
                            awaitedResultDeclaration
                        ),
                        // source:
                        factory.createPropertyAssignment(
                            factory.createIdentifier("diagnosis_source"), this.createSourceNodeDiagnosisExpression(functionTypeNode)
                        )
                    ],
                    true
                );

                callbackDeclarations.push(callbackDeclaration);
                return factory.createLiteralTypeNode(factory.createStringLiteral("_callback")); // replace with "_callback"
            }
            return visitChilds(value, context)
        });

        // ** Obtain, what goes into typia.validateEquals<...> ***
        let typeParamForTypiaValidate: TypeNode = factory.createTupleTypeNode(methodParametersWithPlaceholders);
        if (node.parameters.some(p => p.type === undefined)) { // Some parameters don't have an explicit type ? (i.e. the type is inherited from the base class)
            if (callbackDeclarations.length > 0) {
                throw new Error(`Parameter '${(node.parameters.find(p => p.type === undefined) as any)!.name.escapedText}' does not have a (/ an explicit) type in remote method ${methodName}. In combination with declared callback functions, all parameters must have explicit types. Location: ${this.diag_sourceLocation(node)}`) // TODO: add diagnosis
            }

            // Use the old style: Parameters<typeof this.prototype["method name"]>. This worked very fine in old versions but we now want to battle-test the other style
            typeParamForTypiaValidate = factory.createTypeReferenceNode(
                factory.createIdentifier("Parameters"),
                [factory.createIndexedAccessTypeNode(
                    factory.createTypeQueryNode(
                        factory.createQualifiedName(
                            factory.createIdentifier("this"),
                            factory.createIdentifier("prototype")
                        ),
                        undefined
                    ),
                    factory.createLiteralTypeNode(factory.createStringLiteral(methodName))
                )]
            )
        }

        // ** compose result **
        // @ts-ignore
        return factory.createObjectLiteralExpression(
            [
                // arguments: {...}
                factory.createPropertyAssignment(
                    factory.createIdentifier("arguments"),
                    factory.createObjectLiteralExpression(
                        Object.keys(arguments_typiaFuncs).map((typiaFnName) => // for validateEquals + validatePrune
                            factory.createPropertyAssignment(
                                factory.createIdentifier(typiaFnName),
                                factory.createArrowFunction(
                                    undefined,
                                    undefined,
                                    [factory.createParameterDeclaration(
                                        undefined,
                                        undefined,
                                        factory.createIdentifier("args"),
                                        undefined,
                                        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                                        undefined
                                    )],
                                    undefined,
                                    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                                    factory.createCallExpression(arguments_typiaFuncs[typiaFnName],
                                        [typeParamForTypiaValidate],
                                        [factory.createIdentifier("args")]
                                    )
                                )
                            )),
                        true
                    )
                ),

                // result: {...}
                factory.createPropertyAssignment(
                    factory.createIdentifier("result"),
                    factory.createObjectLiteralExpression(
                        Object.keys(result_typiaFuncs).map((typiaFnName) => // for validateEquals + validatePrune
                            factory.createPropertyAssignment(
                                factory.createIdentifier(typiaFnName),
                                factory.createArrowFunction(
                                    undefined,
                                    undefined,
                                    [factory.createParameterDeclaration(
                                        undefined,
                                        undefined,
                                        factory.createIdentifier("value"),
                                        undefined,
                                        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                                        undefined
                                    )],
                                    undefined,
                                    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                                    factory.createCallExpression(arguments_typiaFuncs[typiaFnName],
                                        [factory.createTypeReferenceNode(
                                            factory.createIdentifier("Awaited"), [factory.createTypeReferenceNode(
                                                factory.createIdentifier("ReturnType"),
                                                [factory.createIndexedAccessTypeNode(
                                                    factory.createTypeQueryNode(
                                                        factory.createQualifiedName(
                                                            factory.createIdentifier("this"),
                                                            factory.createIdentifier("prototype")
                                                        ),
                                                        undefined
                                                    ),
                                                    factory.createLiteralTypeNode(factory.createStringLiteral(methodName))
                                                )]
                                            )]
                                        )],
                                        [factory.createIdentifier("value")]
                                    )
                                )
                            )),
                        true
                    )
                ),

                // callbacks: [...]:
                factory.createPropertyAssignment(
                    factory.createIdentifier("callbacks"),
                    factory.createArrayLiteralExpression(
                        callbackDeclarations,
                        false
                    )
                ),
                // jsDoc:
                factory.createPropertyAssignment(
                    factory.createIdentifier("jsDoc"), this.createJsDocExpression(node, methodName)
                ),
                // diagnosis_source:
                factory.createPropertyAssignment(
                    factory.createIdentifier("diagnosis_source"), this.createSourceNodeDiagnosisExpression(node)
                )
            ],
            true
        );
    }

    /**
     * Crates the following expression like in readme.md#how-it-works
     * <code><pre>
     * {
     *     comment: "...",
     *     params: {...},
     *     ...
     * }
     * </pre></code>
     *
     * or
     *
     * <code><pre>
     *     undefined
     * </pre></code>
     *
     *
     * @param methodName
     * @private
     */
    private createJsDocExpression(node: MethodDeclaration, diagnosis_methodName: string) {
        const factory = this.context.factory;

        if(!node.jsDoc || node.jsDoc.length == 0 ) { // no jsdoc
            return factory.createIdentifier("undefined");
        }

        const jsdoc = node.jsDoc[node.jsDoc.length - 1]; // use last jsDoc

        const comment = jsdoc.comment || "";
        if(typeof comment !== "string") {
            throw new Error(`Expected comment to be a string. Got: ${comment}. Location: ${this.diag_sourceLocation(node)}`); // TODO add to diagnostics instead
        }

        // Collect params and tags
        const params: Record<string, string> = {}
        const tags: {name:string, comment?: string}[] = []
        jsdoc.tags?.forEach(tag => {
            const name = (tag.tagName.escapedText as string).toLowerCase()
            const comment = tag.comment;
            if(comment && typeof comment !== "string") {
                throw new Error(`Expected comment to be a string. Got: ${comment}. Location: ${this.diag_sourceLocation(node)}` ); // TODO add to diagnostics instead
            }

            if(name === "param") {
                const paramname = (tag as any).name?.escapedText;
                if(paramname && comment) {
                    params[paramname] = comment;
                }
            }
            else {
                const tagName: Node | undefined = (tag as any).name;
                tags.push({name, comment})
            }
        })

        // JSDoc. Example from readme.md#how-it-works Copy&pasted through the [AST viewer tool](https://ts-ast-viewer.com/)
        let jsDocExpression = factory.createObjectLiteralExpression(
            [
                factory.createPropertyAssignment(
                    factory.createIdentifier("comment"),
                    factory.createStringLiteral(comment)
                ),
                factory.createPropertyAssignment(
                    factory.createIdentifier("params"),
                    factory.createObjectLiteralExpression(
                        Object.keys(params).map(paramName =>
                            factory.createPropertyAssignment(
                            factory.createIdentifier(paramName),
                            factory.createStringLiteral(params[paramName])
                        )),
                        false
                    )
                ),
                factory.createPropertyAssignment(
                    factory.createIdentifier("tags"),
                    factory.createArrayLiteralExpression(
                         tags.map(tag => factory.createObjectLiteralExpression(
                            [
                                factory.createPropertyAssignment(
                                    factory.createIdentifier("name"),
                                    factory.createStringLiteral(tag.name)
                                ),
                                factory.createPropertyAssignment(
                                    factory.createIdentifier("comment"),
                                    tag.comment !== undefined?factory.createStringLiteral(tag.comment):factory.createIdentifier("undefined")
                                )
                            ],
                            false
                        )),
                        false
                    )
                )
            ],
            true
        )
        return jsDocExpression;
    }

    /**
     * Crates the following expression like in readme.md#how-it-works
     * <code><pre>
     * static getRemoteMethodsMeta() {
     *     ....
     * }
     * </pre></code>
     *
     * @param methodName
     * @private
     */
    private create_static_getRemoteMethodsMeta_expression() : string {
        return `` +
            `static getRemoteMethodsMeta(): (typeof this.type_remoteMethodsMeta) {
                this.__hello_developer__make_sure_your_class_is_a_subclass_of_ServerSession; /* Give a friendly error message when this is not the case. Otherwise the following statement "const typia = ..." would fail and leaves the user wondering. */
                let typia = this.typiaRuntime; /* We need a "typia" defined in the scope, but let restfuncs manage where that dependency comes from */
                const result= {
                    transformerVersion: {major: ${transformerVersion.major},  feature: ${transformerVersion.feature} },
                    instanceMethods: {${Object.keys(this.currentClass_instanceMethodsMeta!).map(methodName => `
                        ${methodName}: ${this.nodeToString(this.currentClass_instanceMethodsMeta![methodName], true)}`).join(",\n")}
                    }
                };
        
                return result; /* Code style note for this line: Why not do \`return {...}\` directly ? This tiny difference allows for extra properties which ensure backward compatibility with older "restfuncs-server" packages. */
            }`
    }

    nodeToString(node: Node, removeComments= false): string {
        const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments});
        return  printer.printNode(ts.EmitHint.Unspecified, node, this.sourceFile) as string;
    }

    /**
     * Creates a node, that declares a SourceNodeDiagnosis (defined in ServerSession.ts) object.
     *
     * To output the info at runtime: i.e. "MyServerSessionClass.ts:23:30, reading: async myRemoteMethod(param1:...): Promise<void> {}
     * @param node
     */
    createSourceNodeDiagnosisExpression(node: Node) {
        const factory = this.context.factory;
        if((node as any).body !== undefined) {
            // Empty the body
            node = structuredClone(node);
            (node as any).body = factory.createBlock([],false);
        }

        const lineAndChar = this.sourceFile.getLineAndCharacterOfPosition((node.getStart?.(this.sourceFile, false) || node.pos));


        return factory.createObjectLiteralExpression(
            [
                factory.createPropertyAssignment(
                    factory.createIdentifier("file"),
                    factory.createStringLiteral(this.sourceFile.fileName)
                ),
                factory.createPropertyAssignment(
                    factory.createIdentifier("line"),
                    factory.createNumericLiteral(lineAndChar.line + 1)
                ),
                factory.createPropertyAssignment(
                    factory.createIdentifier("character"),
                    factory.createNumericLiteral(lineAndChar.character + 1)
                ),
                factory.createPropertyAssignment(
                    factory.createIdentifier("signatureText"),
                    factory.createStringLiteral(this.nodeToString(node, false))
                )
            ],
            false
        )

    }

    diag_sourceLocation(node: Node) {
        const lineAndChar = this.sourceFile.getLineAndCharacterOfPosition((node.getStart?.(this.sourceFile, false) || node.pos));
        return `${this.sourceFile.fileName}:${lineAndChar.line+1}:${lineAndChar.character+1}`
    }
}
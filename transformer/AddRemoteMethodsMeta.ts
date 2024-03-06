import ts, {
    ClassDeclaration,
    MethodDeclaration,
    Node,
    ObjectLiteralExpression,
    PropertyAccessExpression,
    SyntaxKind
} from 'typescript';
import {FileTransformRun} from "./transformerUtil";
import {transformerVersion} from "./index";


/**
 * Transformer that adds the following statement to the method body (like in readme.md#how-it-works)
 * <code><pre>
 * static getRemoteMethodsMeta() {
 *     ....
 * }
 * </pre></code>
 */
export class AddRemoteMethodsMeta extends FileTransformRun {

    diagnosis_currentClass_instanceMethodsSeen?: Set<string>;
    currentClass_instanceMethodsMeta?: Record<string, ObjectLiteralExpression>; // The {...} that should be added below... see example in readme.md

    /* Visitor Function */
    visit(node: Node): Node {
        if (node.kind === SyntaxKind.MethodDeclaration) { // @remote ?
            const methodDeclaration = (node as MethodDeclaration)
            if(this.getChilds(methodDeclaration).some(n => n.kind == SyntaxKind.StaticKeyword)) { // static ?
                return node;
            }
            if(this.getParent().kind !== SyntaxKind.ClassDeclaration) { // Method not under a class (i.e. an anonymous object ?}
                return node;
            }

            const methodName = (methodDeclaration.name as any).escapedText;
            try {
                let remoteDecorator = this.getChilds(methodDeclaration).find(d => d.kind === SyntaxKind.Decorator);
                if (!remoteDecorator) { // no @remote found ?
                    return node;
                }

                // Diagnosis: Check for overloads:
                if(this.diagnosis_currentClass_instanceMethodsSeen?.has(methodName)) { // Seen twice ?
                    throw new Error(`@remote methods cannot have multiple/overloaded signatures: ${methodName}`) // TODO: add diagnosis
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
                    // add "static getRemoteMethodsMeta() {...}" method:
                    // @ts-ignore yes, a bit hacky, but with factory.crateClassDeclation we might also miss some properties
                    result.members = this.context.factory.createNodeArray([...result.members.values(), this.create_static_getRemoteMethodsMeta_expression()])
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
        const factory = this.context.factory;

        const typiaFuncs:Record<string, PropertyAccessExpression> = {
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

        // Example from readme.md#how-it-works Copy&pasted through the [AST viewer tool](https://ts-ast-viewer.com/)
        // @ts-ignore
        return factory.createObjectLiteralExpression(
            [
                factory.createPropertyAssignment(
                    factory.createIdentifier("arguments"),
                    factory.createObjectLiteralExpression(
                        Object.keys(typiaFuncs).map((typiaFnName) =>
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
                                factory.createCallExpression(typiaFuncs[typiaFnName],
                                    [factory.createTypeReferenceNode(
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
                                    )],
                                    [factory.createIdentifier("args")]
                                )
                            )
                        )),
                        true
                    )
                ),
                factory.createPropertyAssignment(
                    factory.createIdentifier("result"),
                    factory.createObjectLiteralExpression(
                        [],
                        true
                    )
                ),
                factory.createPropertyAssignment(
                    factory.createIdentifier("jsDoc"), this.createJsDocExpression(node, methodName)
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
            throw new Error(`Expected comment to be a string. Got: ${comment}` ); // TODO add to diagnostics instead
        }

        // Collect params and tags
        const params: Record<string, string> = {}
        const tags: {name:string, comment?: string}[] = []
        jsdoc.tags?.forEach(tag => {
            const name = (tag.tagName.escapedText as string).toLowerCase()
            const comment = tag.comment;
            if(comment && typeof comment !== "string") {
                throw new Error(`Expected comment to be a string. Got: ${comment}` ); // TODO add to diagnostics instead
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
    private create_static_getRemoteMethodsMeta_expression() : MethodDeclaration {
        const factory = this.context.factory;


        let instanceMethods = factory.createObjectLiteralExpression(
            Object.keys(this.currentClass_instanceMethodsMeta!).map(methodName => factory.createPropertyAssignment(
                factory.createStringLiteral(methodName), this.currentClass_instanceMethodsMeta![methodName]
            )),
            true
        );

        // Example from readme.md#how-it-works Copy&pasted through the [AST viewer tool](https://ts-ast-viewer.com/)
        return factory.createMethodDeclaration(
            [factory.createToken(ts.SyntaxKind.StaticKeyword)],
            undefined,
            factory.createIdentifier("getRemoteMethodsMeta"),
            undefined,
            undefined,
            [],
            factory.createParenthesizedType(factory.createTypeQueryNode(
                factory.createQualifiedName(
                    factory.createIdentifier("this"),
                    factory.createIdentifier("type_remoteMethodsMeta")
                ),
                undefined
            )),
            factory.createBlock(
                [
                    factory.createExpressionStatement(factory.createPropertyAccessExpression(
                        factory.createThis(),
                        factory.createIdentifier("__hello_developer__make_sure_your_class_is_a_subclass_of_ServerSession")
                    )),
                    factory.createVariableStatement(
                        undefined,
                        factory.createVariableDeclarationList(
                            [factory.createVariableDeclaration(
                                factory.createIdentifier("typia"),
                                undefined,
                                undefined,
                                factory.createPropertyAccessExpression(
                                    factory.createThis(),
                                    factory.createIdentifier("typiaRuntime")
                                )
                            )],
                            ts.NodeFlags.Let
                        )
                    ),
                    factory.createReturnStatement(factory.createObjectLiteralExpression(
                        [
                            factory.createPropertyAssignment(
                                factory.createIdentifier("transformerVersion"),
                                factory.createObjectLiteralExpression(
                                    [
                                        factory.createPropertyAssignment(
                                            factory.createIdentifier("major"),
                                            factory.createIdentifier(`${transformerVersion.major}`)
                                        ),
                                        factory.createPropertyAssignment(
                                            factory.createIdentifier("feature"),
                                            factory.createIdentifier(`${transformerVersion.feature}`)
                                        )
                                    ],
                                    false
                                )
                            ),
                            factory.createPropertyAssignment(
                                factory.createIdentifier("instanceMethods"),
                                instanceMethods
                            )
                        ],
                        true
                    ))
                ],
                true
            )
        )

    }
}
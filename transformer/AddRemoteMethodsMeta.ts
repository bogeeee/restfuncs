import ts, {
    ClassDeclaration,
    Decorator,
    MethodDeclaration,
    Node,
    ObjectLiteralExpression,
    SyntaxKind
} from 'typescript';
import {FileTransformerOOP} from "./transformerUtil";
import {transformerVersion} from "./index";


/**
 * Transformer that adds the following statement to the method body (like in readme.md#how-it-works)
 * <code><pre>
 * static getRemoteMethodsMeta() {
 *     ....
 * }
 * </pre></code>
 */
export class AddRemoteMethodsMeta extends FileTransformerOOP {

    diagnosis_currentClass_instanceMethodsSeen?: Set<string>;
    currentClass_instanceMethodsMeta?: Record<string, ObjectLiteralExpression>; // The {...} that should be added below... see example in readme.md

    /* Visitor Function */
    visit(node: Node): Node {
        if (node.kind === SyntaxKind.MethodDeclaration) { // @remote ?
            const methodDeclaration = (node as MethodDeclaration)
            if(this.getChilds(methodDeclaration).some(n => n.kind == SyntaxKind.StaticKeyword)) { // static ?
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

                this.currentClass_instanceMethodsMeta![methodName] = this.createMethodMetaExpression(methodName) // create the code:
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
    createMethodMetaExpression(methodName: string) {
        const factory = this.context.factory;

        // Example from readme.md#how-it-works Copy&pasted through the [AST viewer tool](https://ts-ast-viewer.com/)
        return factory.createObjectLiteralExpression(
            [
                factory.createPropertyAssignment(
                    factory.createIdentifier("arguments"),
                    factory.createObjectLiteralExpression(
                        [factory.createPropertyAssignment(
                            factory.createIdentifier("validate"),
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
                                factory.createCallExpression(
                                    factory.createPropertyAccessExpression(
                                        factory.createIdentifier("typia"),
                                        factory.createIdentifier("validate")
                                    ),
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
                        )],
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
                    factory.createIdentifier("jsDoc"),
                    factory.createObjectLiteralExpression(
                        [],
                        true
                    )
                )
            ],
            true
        );
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
                factory.createStringLiteral("myMethod"), this.currentClass_instanceMethodsMeta![methodName]
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
            undefined,
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
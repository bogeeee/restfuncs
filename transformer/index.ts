import * as ts from 'typescript';
import { factory} from "typescript"
import type { TransformerExtras, PluginConfig } from 'ts-patch';
import typescriptRttiTransformer from "typescript-rtti/dist/transformer";
import typiaTransformer from "typia/lib/transform"

/** Changes string literal 'before' to 'after' */
export default function (program: ts.Program, pluginConfig: PluginConfig, extras: TransformerExtras): ts.TransformerFactory<any> { // TODO: not the proper signature but makes the example work
    const { ts: tsInstance } = extras;

    const typescriptRttiTransformerFactory = typescriptRttiTransformer(program); // init
    const typiaTransformerFactory = typiaTransformer(program, pluginConfig as any, extras);

    // Our transformerfactory:
    return (ctx: ts.TransformationContext) => {
        return (sourceFile: ts.SourceFile):ts.SourceFile => {

            //let typescriptRttiTransformer = typescriptRttiTransformerFactory(ctx);
            //sourceFile = typescriptRttiTransformer(sourceFile); // run it;

            // @ts-ignore
            tsInstance.visitNode(sourceFile, hasMarker(tsInstance, ctx));

            function visit(node: ts.Node): ts.Node {
                if(tsInstance.isExpressionStatement(node)) {
                    try {
                        let found = false;
                        if (node.getChildren().length > 0) {
                            const inner = node.getChildAt(0);
                            if (tsInstance.isStringLiteral(inner) && inner.text === 'marker') {
                                //return ctx.factory.createStringLiteral('after');
                                found = true;
                            }
                        }
                        if(found) {
                            // Insert: const validator = (obj: unknown) => (typia.validate<B>(obj))
                            return factory.createVariableDeclarationList(
                                [factory.createVariableDeclaration(
                                    factory.createIdentifier("validator"),
                                    undefined,
                                    undefined,
                                    factory.createArrowFunction(
                                        undefined,
                                        undefined,
                                        [factory.createParameterDeclaration(
                                            undefined,
                                            undefined,
                                            factory.createIdentifier("obj"),
                                            undefined,
                                            (factory.createKeywordTypeNode as anyFn)(ts.SyntaxKind.UnknownKeyword),
                                            undefined
                                        )],
                                        undefined,
                                        (factory.createToken as anyFn)(ts.SyntaxKind.EqualsGreaterThanToken),
                                        factory.createParenthesizedExpression(factory.createCallExpression(
                                            factory.createPropertyAccessExpression(
                                                factory.createIdentifier("typia"),
                                                factory.createIdentifier("validate")
                                            ),
                                            [factory.createTypeReferenceNode(
                                                factory.createIdentifier("B"),
                                                undefined
                                            )],
                                            [factory.createIdentifier("obj")]
                                        ))
                                    )
                                )],
                                ts.NodeFlags.Const | ts.NodeFlags.Const
                            )



                        }
                    }
                    catch (e) {

                    }
                }

                return tsInstance.visitEachChild(node, visit, ctx);
            }
            // @ts-ignore
            sourceFile = tsInstance.visitNode(sourceFile, visit);

            // @ts-ignore
            tsInstance.visitNode(sourceFile, hasMarker(tsInstance, ctx));

            let typiaTransformer = typiaTransformerFactory(ctx);
            sourceFile = typiaTransformer(sourceFile); // run it;

            return sourceFile;
        };
    };
}


type anyFn = (...args: any[]) => any


function hasMarker(tsInstance: any, ctx: any) {
    return function visit(node: ts.Node): ts.Node {
        if (tsInstance.isExpressionStatement(node)) {
            try {
                if (node.getChildren().length > 0) {
                    const inner = node.getChildAt(0);
                    // @ts-ignore
                    if (tsInstance.isStringLiteral(inner) && inner.text === 'marker') {
                        //return ctx.factory.createStringLiteral('after');

                        console.log("found marker!");
                    }
                }
            } catch (e) {

            }
        }

        return tsInstance.visitEachChild(node, visit, ctx);
    }
}
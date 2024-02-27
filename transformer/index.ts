import type * as ts from 'typescript';
import type { TransformerExtras, PluginConfig } from 'ts-patch';
import typescriptRttiTransformer from "typescript-rtti/dist/transformer";

/** Changes string literal 'before' to 'after' */
export default function (program: ts.Program, pluginConfig: PluginConfig, { ts: tsInstance }: TransformerExtras): ts.TransformerFactory<any> { // TODO: not the proper signature but makes the example work

    const typescriptRttiTransformerFactory = typescriptRttiTransformer(program); // init

    // Our transformerfactory:
    return (ctx: ts.TransformationContext) => {
        return (sourceFile: ts.SourceFile):ts.SourceFile => {

            let typescriptRttiTransformer = typescriptRttiTransformerFactory(ctx);
            sourceFile = typescriptRttiTransformer(sourceFile); // run it;



            function visit(node: ts.Node): ts.Node {
                if (tsInstance.isStringLiteral(node) && node.text === 'before') {
                    return ctx.factory.createStringLiteral('after');
                }
                return tsInstance.visitEachChild(node, visit, ctx);
            }
            // @ts-ignore
            sourceFile = tsInstance.visitNode(sourceFile, visit);

            return sourceFile;
        };
    };
}

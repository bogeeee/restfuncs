import ts, {
    CompilerHost,
    CompilerOptions,
    Program,
    SyntaxKind,
    TransformationContext,
    SourceFile,
    Node,
    factory
} from 'typescript';
import { PluginConfig, ProgramTransformerExtras } from "ts-patch";
import {} from 'ts-expose-internals'
import ex = CSS.ex;

// From: https://github.com/nonara/ts-patch/discussions/29#discussioncomment-325979


/* ****************************************************************************************************************** */
// region: Helpers
/* ****************************************************************************************************************** */

/**
 * Patches existing Compiler Host (or creates new one) to allow feeding updated file content from cache
 */
function getPatchedHost(
    maybeHost: CompilerHost | undefined,
    tsInstance: typeof ts,
    compilerOptions: CompilerOptions
): CompilerHost & { fileCache: Map<string, SourceFile> }
{
    const fileCache = new Map();
    const compilerHost = maybeHost ?? tsInstance.createCompilerHost(compilerOptions, true);
    const originalGetSourceFile = compilerHost.getSourceFile;

    return Object.assign(compilerHost, {
        getSourceFile(fileName: string, languageVersion: ts.ScriptTarget) {
            fileName = tsInstance.normalizePath(fileName);
            if (fileCache.has(fileName)) return fileCache.get(fileName);

            const sourceFile = originalGetSourceFile.apply(void 0, Array.from(arguments) as any);
            fileCache.set(fileName, sourceFile);

            return sourceFile;
        },
        fileCache
    });
}

// endregion


/* ****************************************************************************************************************** */
// region: Program Transformer
/* ****************************************************************************************************************** */

export default function transformProgram(
    program: Program,
    host: CompilerHost | undefined,
    config: PluginConfig,
    extras?: ProgramTransformerExtras,
): Program {
    if(!extras) {
        throw new Error(`Please add the flag "transformProgram": true to the transformer inside tsconfig.json`);
    }

    const { ts: tsInstance } = extras;
    const compilerOptions = program.getCompilerOptions();
    const compilerHost = getPatchedHost(host, tsInstance, compilerOptions);
    const rootFileNames = program.getRootFileNames().map(tsInstance.normalizePath);

    /* Transform AST */
    const transformedSource = tsInstance.transform(
        /* sourceFiles */ program.getSourceFiles().filter(sourceFile => rootFileNames.includes(sourceFile.fileName)),
        /* transformers */ [ transformAst.bind(tsInstance) ],
        compilerOptions
    ).transformed;

    /* Render modified files and create new SourceFiles for them to use in host's cache */
    const { printFile } = tsInstance.createPrinter();
    for (const sourceFile of transformedSource) {
        const { fileName, languageVersion } = sourceFile;
        const updatedSourceFile = tsInstance.createSourceFile(fileName, printFile(sourceFile), languageVersion);
        updatedSourceFile.version = sourceFile.version;
        compilerHost.fileCache.set(fileName, updatedSourceFile);
    }

    /* Re-create Program instance */
    return tsInstance.createProgram(rootFileNames, compilerOptions, compilerHost);
}

// endregion


/* ****************************************************************************************************************** */
// region: AST Transformer
/* ****************************************************************************************************************** */

/**
 * Change all 'number' keywords to 'string'
 *
 * @example
 * // before
 * type A = number
 *
 * // after
 * type A = string
 */
function transformAst(this: typeof ts, context: TransformationContext) {
    const tsInstance = this;

    /* Transformer Function */
    return (sourceFile: SourceFile) => {
        return tsInstance.visitEachChild(sourceFile, visit, context);

        /* Visitor Function */
        function visit(node: Node): Node {
            if (node.kind === SyntaxKind.StringLiteral && node.text === "marker") {
                const factory = context.factory;
                return factory.createIdentifier("validator"),
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
            }
            else
                return tsInstance.visitEachChild(node, visit, context);
        }
    }
}

// endregion
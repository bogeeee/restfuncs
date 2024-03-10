import ts, {CompilerHost, CompilerOptions, Program, SourceFile} from 'typescript';
import {PluginConfig, ProgramTransformerExtras} from "ts-patch";
import {AddRemoteMethodsMeta} from "./AddRemoteMethodsMeta";
import {FileTransformRun, TransformerFactoryOOP} from "./transformerUtil";

// From: https://github.com/nonara/ts-patch/discussions/29#discussioncomment-325979

export const transformerVersion = {major: 1,  feature: 1 }

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

    const transformerFactoryOOP = new TransformerFactoryOOP(AddRemoteMethodsMeta);

    /* Transform AST */
    tsInstance.transform(
        /* sourceFiles */ program.getSourceFiles().filter(sourceFile => rootFileNames.includes(sourceFile.fileName)),
        /* transformerFactoryOOP */ [ transformerFactoryOOP.asFunction ],
        compilerOptions
    )

    transformerFactoryOOP.transformRunsDone.forEach(transformRun => {
        if(transformRun.astWasModified) {
            /* Render modified files and create new SourceFiles for them to use in host's cache */
            const {printFile} = tsInstance.createPrinter();
            const sourceFile = transformRun.sourceFile;
            const updatedSourceFile = tsInstance.createSourceFile(sourceFile.fileName, printFile(sourceFile), sourceFile.languageVersion);
            updatedSourceFile.version = `${sourceFile.version}_restfuncs_${transformerVersion.major}.${transformerVersion.feature}`;
            compilerHost.fileCache.set(sourceFile.fileName, updatedSourceFile);
        }
    })



    /* Re-create Program instance */
    return tsInstance.createProgram(rootFileNames, compilerOptions, compilerHost);
}

// endregion
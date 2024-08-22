import ts, {Node, SourceFile, SyntaxKind, TransformationContext, TransformerFactory} from "typescript";

type ClassOf<T> = {
    new(...args: any[]): T
}

/**
 * Transformerfactory in a better oop style
 */
export class TransformerFactoryOOP<FT extends FileTransformRun> {
    transformRunsDone: FT[] = []
    fileTransformRunClass: ClassOf<FileTransformRun>;


    constructor(fileTransformerRunClass: ClassOf<FT>) {
        this.fileTransformRunClass = fileTransformerRunClass;
    }

    /**
     * Transformer for the typescript api (does not offer such a nice oop style)
     */
    get asFunction(): TransformerFactory<SourceFile> {
        return (context: TransformationContext) => {
            return (sourceFile: SourceFile): SourceFile => {
                const fileTransformer = new this.fileTransformRunClass(ts, sourceFile, context);
                this.transformRunsDone.push(fileTransformer as FT);
                return ts.visitEachChild(sourceFile, (node) => fileTransformer.visit(node), context);
            }
        }
    }
}

/**
 * Stores the context and result of one run. Don't reuse.
 */
export abstract class FileTransformRun {
    tsInstance: typeof ts;
    sourceFile: SourceFile
    context: TransformationContext;
    parentNodes: Node[] = []
    used = false;

    constructor(tsInstance: typeof ts, sourceFile: SourceFile, context: TransformationContext) {
        this.tsInstance = tsInstance;
        this.sourceFile = sourceFile;
        this.context = context;
    }


    getParent = () => {
        return this.parentNodes[this.parentNodes.length - 1];
    };

    /**
     * Vistor function
     * The body must call visitChilds, if the subtree should be visited
     * @param node
     */
    abstract visit(node: Node): Node;


    protected visitChilds(node: Node) {
        this.parentNodes.push(node);
        try {
            return this.tsInstance.visitEachChild(node, (node) => this.visit(node), this.context);
        } finally {
            this.parentNodes.pop();
        }
    }



    /**
     * @return text of the node (only for string literals, etc)
     * @param node
     */
    getText(node: Node): string {
        // @ts-ignore
        return node.text;
    }

    getChilds(node: Node) {
        let result: Node[] = [];
        this.tsInstance.forEachChild(node, child => result.push(child));
        return result
    }

    /**
     *
     * @param tsInstance
     * @param node
     * @param escaped don't know why but sometimes the name can only be read by the escapedText property.
     */
    getIdentifierName(node: Node, escaped = false) {
        const identifierNode = this.getChilds(node).find(child => child.kind == SyntaxKind.Identifier);
        if(!identifierNode) {
            throw new Error("Identifier node not found")
        }
        if(escaped) {
            return (identifierNode as any).escapedText;
        }
        return identifierNode.getText();
    }
}

export class TextPatch {
    /**
     * character index (not byte index) => content to insert
     */
    patches: {position: number, contentToInsert: string}[] = [];
    applyPatches(content: string) {
        this.patches.sort((a,b) => a.position - b.position);
        let result = "";
        let emittedTil = 0;
        for(const patch of this.patches) {
            // emit the stuff before the patch
            result+=content.slice(emittedTil, patch.position);
            emittedTil = patch.position;

            result+=patch.contentToInsert;
        }

        result+= content.slice(emittedTil);// emit the rest

        return result;
    }
}
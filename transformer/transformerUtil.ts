import ts, {Node, SourceFile, SyntaxKind, TransformationContext, TransformerFactory} from "typescript";

type ClassOf<T> = {
    new(...args: unknown[]): T
}

/**
 * Transformerfactory in a better oop style
 */
export class TransformerFactoryOOP<FT extends FileTransformerOOP> {
    producedFileTransformers: FT[] = []
    fileTransformerClass: ClassOf<FileTransformerOOP>;


    constructor(fileTransformerClass: ClassOf<FT>) {
        this.fileTransformerClass = fileTransformerClass;
    }

    /**
     * Transformer for the typescript api (does not offer such a nice oop style)
     */
    get asFunction(): TransformerFactory<SourceFile> {
        return (context: TransformationContext) => {
            const fileTransformer = new this.fileTransformerClass(ts, context);
            // @ts-ignore
            this.producedFileTransformers.push(fileTransformer);
            return fileTransformer.asFunction
        }
    }
}

/**
 * Transforms one file. One time usage.
 */
export abstract class FileTransformerOOP {
    tsInstance: typeof ts;
    context: TransformationContext;
    parentNodes: Node[] = []
    used = false;

    constructor(tsInstance: typeof ts, context: TransformationContext) {
        this.tsInstance = tsInstance;
        this.context = context;
    }


    getParent = () => {
        return this.parentNodes[this.parentNodes.length - 1];
    };

    /* Transformer Function (for the ts api) */
    get asFunction() {
        return (sourceFile: SourceFile): SourceFile => {
            // Safety check:
            if (this.used) {
                throw new Error("Can only use ServerSessionFileASTTransformer for one run.")
            }
            this.used = true

            return this.tsInstance.visitEachChild(sourceFile, (node) => this.visit(node), this.context);
        }
    }

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
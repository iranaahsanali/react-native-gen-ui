import { OPENAI_BASE_PATH } from './constants';
import {
  ChatCompletion,
  ChatCompletionCallbacks,
  ChatCompletionCreateParams,
} from './chat-completion';

export class OpenAIApi {
  apiKey: string;
  basePath: string;
  customServerPath?: string;
  takeOnlyLastInput?: boolean;
  contentNodeName: string;
  completionNodeName: string;
  additionalHeaders?: any;
  additionalBody?: any;
  constructor({
    apiKey,
    basePath,
    customServerPath,
    takeOnlyLastInput,
    contentNodeName,
    completionNodeName,
    additionalHeaders,
    additionalBody,
  }: {
    apiKey: string;
    basePath?: string;
    customServerPath?: string;
    takeOnlyLastInput?: boolean;
    contentNodeName: string;
    completionNodeName: string;
    additionalHeaders?: any;
    additionalBody?: any;
  }) {
    this.apiKey = apiKey;
    this.basePath = basePath ?? OPENAI_BASE_PATH;
    this.customServerPath = customServerPath;
    this.takeOnlyLastInput = takeOnlyLastInput ?? false;
    this.contentNodeName = contentNodeName;
    this.completionNodeName = completionNodeName;
    this.additionalHeaders = additionalHeaders;
    this.additionalBody = additionalBody;
  }

  public createChatCompletion(
    params: ChatCompletionCreateParams,
    callbacks: ChatCompletionCallbacks,
  ): Promise<ChatCompletion> {
    return new Promise((resolve) => {
      const cc = new ChatCompletion(this, params, callbacks);
      cc.start();
      resolve(cc);
    });
  }
}

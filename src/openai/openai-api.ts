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
  constructor({ apiKey, basePath, customServerPath, takeOnlyLastInput }: { apiKey: string; basePath?: string; customServerPath?: string; takeOnlyLastInput?: boolean}) {
    this.apiKey = apiKey;
    this.basePath = basePath ?? OPENAI_BASE_PATH;
    this.customServerPath = customServerPath;
    this.takeOnlyLastInput =  takeOnlyLastInput ?? false;
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

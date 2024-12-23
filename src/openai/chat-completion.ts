import {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources';
import z from 'zod';
import { OpenAIApi } from './openai-api';
import React, { ReactElement } from 'react';
import {
  filterOutReactComponents,
  isAsyncGeneratorFunction,
  sleep,
  toolsToJsonSchema,
} from './utils';
import EventSource, { EventSourceEvent } from 'react-native-sse';

// Tool's render function can return either data or a component
export type ChatCompletionMessageOrReactElement =
  | ReactElement
  | ChatCompletionMessageParam;

// Tool definition
// Takes a description (visible to model)
// Parameters (zod schema), that are converted to json schema and then sent to the model
// Render function that takes the parameters and returns a generator that yields components, then returns both data and a component to display
export interface Tool<Z extends z.Schema> {
  description: string;
  parameters: Z;
  render: (args: z.infer<Z>) => ToolRenderReturnType;
}

// A generic type that allows for use of type-safe validators
export type ValidatorsObject = {
  [name: string]: z.Schema;
};

// Generic tools type definition
export type Tools<V extends ValidatorsObject = {}> = {
  [name in keyof V]: Tool<V[name]>;
};

// Chat completion parameters have a different, type safe definition
export type ChatCompletionCreateParams = Omit<
  ChatCompletionCreateParamsStreaming,
  'tools'
> & {
  tools?: Tools<{ [toolName: string]: z.Schema }>;
};

type ToolGeneratorReturn = { component: ReactElement; data: object };

// A generator that will yield some (0 or more) React components and then finish with an object, containing both the data and the component to display.
// Allow also to return only a component and data in case the tool does not need to do any async operations.
export type ToolRenderReturnType =
  | AsyncGenerator<ReactElement, ToolGeneratorReturn, unknown>
  | ToolGeneratorReturn;

// Chat completion callbacks, utilized by the caller
export interface ChatCompletionCallbacks {
  onChunkReceived?: (messages: ChatCompletionMessageOrReactElement[]) => void;
  onDone?: (messages: ChatCompletionMessageOrReactElement[]) => void;
  onError?: (error: Error) => void;
}

export class ChatCompletion {
  private eventSource: EventSource | null = null;
  private api: OpenAIApi;
  private callbacks: ChatCompletionCallbacks;
  private params: ChatCompletionCreateParams;

  private newMessage: string = '';
  // TODO: handle parallel tool calls
  private newToolCall: ChatCompletionMessageToolCall.Function = {
    name: '',
    arguments: '',
  };
  private toolCallResult: any = null;
  private toolRenderResult: ReactElement | null = null;
  private finished = false;

  constructor(
    api: OpenAIApi,
    params: ChatCompletionCreateParams,
    callbacks: ChatCompletionCallbacks,
  ) {
    this.api = api;
    this.params = params;
    this.callbacks = callbacks;
  }

  // Inits the completion and starts the streaming
  start() {
    // Create a new event source using Completions API
    this.eventSource = new EventSource<string>(
      this.api.customServerPath
        ? this.api.customServerPath
        : `${this.api.basePath}/chat/completions`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.api.apiKey}`,
          ...(this.api.additionalHeaders || {}),
        },
        // Do not poll, just connect once
        pollingInterval: 0,
        method: 'POST',
        body: this.api.takeOnlyLastInput
          ? JSON.stringify({
              question:
                this.params.messages[this.params.messages.length - 1].content,
              ...(this.api.additionalBody || {}),
            })
          : this.serializeParams(),
      },
    );

    // Add event listeners
    this.eventSource.addEventListener(
      'message',
      this.handleNewChunk.bind(this),
    );
    this.eventSource.addEventListener('error', (event) => {
      if (event.type === 'error') {
        console.error('Connection error:', event.message);
        this.callbacks.onError?.(new Error(event.message));
      } else if (event.type === 'exception') {
        console.error('Error:', event.message, event.error);
        this.callbacks.onError?.(new Error(event.message));
      }
    });
  }

  // Handles a new chunk received
  private handleNewChunk(event: EventSourceEvent<'message'>) {
    // Parse the message as a ChatCompletionChunk
    const e = JSON.parse(event.data!) as any;

    // If [DONE], close the connection and mark as done
    if (e?.[`${this.api.completionNodeName}`] == true) {
      this.eventSource?.close();
      return;
    }

    // Handle the case of an empty message
    if (
      !e?.[this.api.contentNodeName] ||
      e?.[this.api.contentNodeName]?.length == 0
    ) {
      console.error('Empty message received.');
      this.callbacks.onError?.(new Error('Empty message received.'));
      return;
    }

    // This library currently only supports one choice
    const content = e?.[this.api.contentNodeName];

    // Handle normal text token delta
    if (content != null) {
      this.newMessage += content;
      this.notifyChunksReceived();
      return;
    }

    // TODO: maybe handle finish reason `length`

    // This should not happen, but if it does, log it
    console.error('Unknown message received:', event.data);
    this.callbacks.onError?.(new Error('Unknown message received.'));
  }

  // Serializes all the parameters to JSON for calling the API
  serializeParams() {
    if (this.params.tools == null) {
      return JSON.stringify(this.params);
    }

    const tools = toolsToJsonSchema(this.params.tools ?? {});
    return JSON.stringify({
      ...this.params,
      tools,
    });
  }

  // Calls all the callbacks with the current messages
  private notifyChunksReceived() {
    if (!this.callbacks.onChunkReceived) {
      return;
    }

    const messages = this.getMessages();
    this.callbacks.onChunkReceived(messages);
  }

  // Returns all the messages that have been received so far,
  // including the new message, tool render result and recursive call result
  private getMessages() {
    const messages: ChatCompletionMessageOrReactElement[] = [];

    if (this.newMessage != null && this.newMessage !== '') {
      messages.push({
        role: 'assistant',
        content: this.newMessage,
      });
    }

    if (this.toolRenderResult != null) {
      messages.push(this.toolRenderResult);
    }

    if (this.toolCallResult != null) {
      messages.push({
        role: 'function',
        name: this.newToolCall.name,
        content: JSON.stringify(this.toolCallResult),
      });
    }

    return messages;
  }

  // Calls the tool and then recursively calls the streaming again
  private async handleToolCall() {
    // Check if the tool call is valid
    if (this.newToolCall.name === '') {
      console.error('Tool call received without a name.');
      this.callbacks.onError?.(new Error('Tool call received without a name.'));
      return;
    }

    // Check if the tool is valid
    if (
      this.params.tools == null ||
      !Object.keys(this.params.tools).includes(this.newToolCall.name)
    ) {
      console.error('Tool call received for unknown tool:', this.newToolCall);
      this.callbacks.onError?.(
        new Error('Tool call received for unknown tool.'),
      );
      return;
    }

    // Extract the chosen tool
    const chosenTool = this.params.tools[this.newToolCall.name];

    // Check if the tool is valid
    if (chosenTool == null) {
      console.error('Tool call received for unknown tool:', this.newToolCall);
      this.callbacks.onError?.(
        new Error('Tool call received for unknown tool.'),
      );
      return;
    }

    // Parse the arguments
    const args = JSON.parse(this.newToolCall.arguments);

    // Verify that the arguments are valid by parsing them with the zod schema
    try {
      chosenTool.parameters.parse(args);
    } catch (e) {
      console.error('Invalid arguments received:', e);
      this.callbacks.onError?.(new Error('Invalid arguments received.'));
      return;
    }

    // This is either
    // - an async generator (if tool will be fetching data asynchronously)
    // - a component and data (if tool does not need to do any async operations)
    const generatorOrData = chosenTool.render(args);

    if (isAsyncGeneratorFunction(generatorOrData)) {
      // Call the tool and iterate over results
      // Use while to access the last value of the generator (what it returns too rather then only what it yields)
      // Only the last returned/yielded value is the one we use
      const generator = generatorOrData;
      let next = null;
      while (next == null || !next.done) {
        // Fetch the next value
        next = await generator.next();
        const value = next.value;

        // If the value is contains data and component, save both
        if (
          value != null &&
          Object.keys(value).includes('data') &&
          Object.keys(value).includes('component')
        ) {
          const v = value as { data: any; component: ReactElement };
          this.toolRenderResult = v.component;
          this.toolCallResult = v.data;
        } else if (React.isValidElement(value)) {
          this.toolRenderResult = value;
        }

        // Update the parent by calling the callbacks
        this.notifyChunksReceived();

        // Break if the generator is done
        if (next.done) {
          break;
        }
      }
    } else {
      // Not a generator, simply call the render function, we received all the data at once.
      const data = generatorOrData;
      this.toolRenderResult = data.component;
      this.toolCallResult = data.data;

      // Update the parent by calling the callbacks
      this.notifyChunksReceived();
    }

    // Call recursive streaming
    await this.streamRecursiveAfterToolCall();
    this.finished = true;
  }

  private async streamRecursiveAfterToolCall() {
    // Create a new completion and stream up messages from this one and any from the recursive ones
    const newCompletion = new ChatCompletion(
      this.api,
      {
        ...this.params,
        messages: [
          ...this.params.messages, // Messages from this completion
          ...filterOutReactComponents(this.getMessages()), // Messages from the recursive completion
        ],
      },
      {
        ...this.callbacks, // Use the same callbacks, except for onChunkReceived and onDone
        onChunkReceived: (messages) => {
          this.callbacks.onChunkReceived?.([
            ...this.getMessages(), // Prepend messages from this completion
            ...messages,
          ]);
        },
        onDone: (messages) => {
          // Compile all messages from this completion and the recursive one
          this.callbacks.onDone?.([...this.getMessages(), ...messages]);
        },
      },
    );

    // Start the new completion
    newCompletion.start();

    // Wait until the new completion is finished
    while (!newCompletion.finished) {
      await sleep(100);
    }
  }
}

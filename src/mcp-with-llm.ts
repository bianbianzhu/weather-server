import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ChatOpenAI } from "@langchain/openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/src/resources/index.js";
import { MessageParam } from "@anthropic-ai/sdk/resources/messages/index.mjs";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool, tool } from "@langchain/core/tools";
import { JsonSchema, jsonSchemaToZod } from "@n8n/json-schema-to-zod";
import { z } from "zod";

const transport = new StdioClientTransport({
  command: process.execPath, // don't use node, it will not work - Error: spawn node ENOENT - the system can't find the node executable in the path when trying to spawn a child process
  args: ["/Users/tianyili/Learn/ml/mcp-servers/weather-server/build/index.js"],
  env: {
    ...process.env,
    OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY ?? "", // somehow, we must provide OPENWEATHER API KEY here, otherwise, the MCP server will not start
  },
});

const mcpClient = new Client(
  {
    name: "weather-server",
    version: "0.0.1",
  },
  {
    capabilities: {},
  }
);

await mcpClient.connect(transport);

// Call LLM with tools
const tools = await mcpClient.request(
  {
    method: "tools/list",
  },
  ListToolsResultSchema
);

if (
  !tools ||
  !tools.tools ||
  !Array.isArray(tools.tools) ||
  tools.tools.length === 0
) {
  throw new Error("No tools found");
}

// Example of MCP Server tools
// {
//     tools: [
//       {
//         name: 'get_forecast',
//         description: 'Get weather forecast for a city',
//         inputSchema: [Object]
//       }
//     ]
//   }

// ====== OpenAI API ======
const openaiCompatibleTools = tools.tools.map<ChatCompletionTool>((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
}));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const messages: ChatCompletionMessageParam[] = [
  { role: "user", content: "What is the weather in Shanghai" },
];

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools: openaiCompatibleTools,
  messages,
});

const toolCall = response.choices[0].message.tool_calls?.[0];

if (toolCall) {
  const toolName = toolCall.function.name;
  const toolArgs = JSON.parse(toolCall.function.arguments);
  console.log(`Tool called: ${toolName}`);

  // Add the assistant's message with the tool call to the messages array
  // Need to include the assistant's message with the tool call in the messages array before adding the tool response (tool message)
  messages.push({
    role: "assistant",
    content: response.choices[0].message.content,
    tool_calls: response.choices[0].message.tool_calls,
  });

  const toolResult = await mcpClient.request(
    {
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
    },
    CallToolResultSchema
  );

  messages.push({
    role: "tool",
    content: JSON.stringify(toolResult),
    tool_call_id: toolCall.id,
  });

  const finalResponse = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
  });

  messages.push(finalResponse.choices[0].message);

  console.log(messages);
}

// ====== Anthropic API ======
// const anthropicCompatibleTools = tools.tools.map((tool) => ({
//   name: tool.name,
//   description: tool.description,
//   input_schema: tool.inputSchema,
//   //   required: tool.inputSchema.required, // This causes error, and it is not a valid field
// }));

// const anthropicMessages: MessageParam[] = [
//   {
//     role: "user",
//     content: [
//       {
//         type: "text",
//         text: "What is the weather in Shanghai.",
//       },
//     ],
//   },
// ];

// const anthropic = new Anthropic({
//   apiKey: process.env.ANTHROPIC_API_KEY,
// });

// const anthropicResponse = await anthropic.messages.create({
//   model: "claude-3-5-sonnet-20240620",
//   tools: anthropicCompatibleTools,
//   messages: anthropicMessages,
//   max_tokens: 1024,
// });

// const toolUseContent = anthropicResponse.content.find(
//   (c) => c.type === "tool_use"
// );

// // Example of tool use content
// // {
// //     type: "tool_use",
// //     id: "toolu_01GRnByfjjDFWcyiQ3ahZ2zu",
// //     name: "get_forecast",
// //     input: {
// //       city: "Shanghai",
// //       days: 1,
// //     },
// //   }

// if (toolUseContent) {
//   const toolName = toolUseContent.name;
//   const toolArgs = toolUseContent.input;

//   console.log(`Tool called: ${toolName}`);

//   anthropicMessages.push({
//     role: "assistant",
//     content: anthropicResponse.content,
//   });

//   const toolResult = await mcpClient.request(
//     {
//       method: "tools/call",
//       params: {
//         name: toolName,
//         arguments: toolArgs,
//       },
//     },
//     CallToolResultSchema
//   );

//   // return tool_result to LLM
//   anthropicMessages.push({
//     role: "user",
//     content: [
//       {
//         type: "tool_result",
//         tool_use_id: toolUseContent.id,
//         content: JSON.stringify(toolResult.content[0].text),
//       },
//     ],
//   });

//   const finalResponse = await anthropic.messages.create({
//     model: "claude-3-5-sonnet-20240620",
//     tools: anthropicCompatibleTools,
//     messages: anthropicMessages,
//     max_tokens: 1024,
//   });

//   console.log(
//     finalResponse.content[0].type === "text"
//       ? finalResponse.content[0].text
//       : JSON.stringify(finalResponse.content[0])
//   );
// }

// ====== Langchain API ======
// const chatHistory: BaseMessage[] = [
//   new HumanMessage("What is the weather in Shanghai"),
// ];

// const langchainChatModel = new ChatOpenAI({
//   model: "gpt-4o",
// });

// const langchainTools = tools.tools.map<DynamicStructuredTool>(
//   ({ name, description, inputSchema }) =>
//     tool(
//       async (input) => {
//         const toolResult = await mcpClient.request(
//           {
//             method: "tools/call",
//             params: { name: name, arguments: input },
//           },
//           CallToolResultSchema
//         );

//         return toolResult.content[0].text;
//       },
//       {
//         name: name,
//         description: description ?? "",
//         schema: jsonSchemaToZod(inputSchema as JsonSchema) as z.ZodObject<any>,
//       }
//     )
// );

// console.log(langchainTools);

// const modelWithTools = langchainChatModel.bindTools(langchainTools);

// const response = await modelWithTools.invoke(chatHistory);

// console.log(response);

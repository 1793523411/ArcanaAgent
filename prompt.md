




帮我在当前项目创建一个应用，一个网页端的智能体，先做个最简单的版本

需要包括前端和服务端，都使用ts来写，服务端框架你可以自己选择，前端需要用React来写，Agent用Langgraph

用户可以在网页中与Agent对话，创建并发起对话，查看历史回话，数据通过文件系统存储，对话与对话隔离，每个对话的上下文管理要合理，该压缩压缩

Agent需要能够执行skill和mcp，自带一些Demo MCP和Skill，用户可以自己在页面中配置

Agent支持流式和非流式，用户在页面上发起对话要用流式的，实时展示AI的工作情况，后端也单独支持通过接口发起非流式调用

关于模型的API走配置文件，我要用火山引擎的模型，下面是我的模型信息：
```
"models": {
    "providers": {
        "volcengine": {
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "apiKey": "92c40427-1ad8-4893-bd09-18eaac5a183f",
        "api": "openai-completions",
        "models": [
            {
            "id": "ep-m-20260227190842-nrldn",
            "name": "doubao-seed-2-0-pro-260215",
            "api": "openai-completions",
            "reasoning": false,
            "input": [
                "text",
                "image"
            ],
            "cost": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0
            },
            "contextWindow": 200000,
            "maxTokens": 8192
            }
        ]
        }
    }
}
```


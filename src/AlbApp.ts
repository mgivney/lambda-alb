import { existsSync, readFileSync, PathLike } from "fs"

import AWS from "aws-sdk"
import { ClientConfiguration, InvocationRequest } from "aws-sdk/clients/lambda"
import { raw as rawBodyParser } from "body-parser"
import commandLineArgs from "command-line-args"
import cors from "cors"
import express, { Request, Response, Application } from "express"
import { Server } from "http"

import { AlbConfig } from "./model/AlbConfig"
import { AlbRequest } from "./model/AlbRequest"
import { AlbResponse } from "./model/AlbResponse"
import { AlbTarget } from "./model/AlbTarget"
import { Options } from "./model/Options"

/**
 * Simple console application that hosts an express HTTP
 * server that simulates an AWS ALB.
 *
 * A request is mapped from the HTTP request to a lambda
 * target, the response from invoking the lambda is mapped to
 * a standard HTTP response and returned to the express client.
 */
export class AlbApp {
    private static readonly MAX_REQUEST_BODY_SIZE = "6144kb"
    private static readonly HTTP_METHODS_WITH_ENTITY = ["POST", "PUT", "PATCH"]
    private static readonly PLAIN_CONTENT_TYPES = ["text/*", "application/json", "application/javascript", "application/xml"]

    public static readonly APP_OPTIONS: any[] = [{
            alias: "c",
            description: "Path to the JSON configuration file",
            name: "config",
            type: String
        }, {
            alias: "h",
            defaultValue: "*",
            description: "Host to listen on (defaults to all)",
            name: "host",
            type: String
        }, {
            alias: "p",
            defaultValue: 8080,
            description: "Port to listen on (defaults to 8080)",
            name: "port",
            type: Number
        }, {
            alias: "o",
            defaultValue: "*",
            description: "CORS origin to accept (default is to accept any origin)",
            name: "corsOrigin",
            type: String
        }, {
            alias: "d",
            defaultValue: false,
            description: "Enable debug logging",
            name: "debug",
            type: Boolean
        }
    ]

    protected readonly expressApp: Application

    private server?: Server
    private debugEnabled: boolean
    private config: AlbConfig
    private lambdaClient: AWS.Lambda

    public constructor() {
        this.expressApp = express()
        this.debugEnabled = false
    }

    /**
     * Starts the express server.
     *
     * @param args Command line arguments for this server, equivalent to `process.argv.splice(2)`.
     *             See --help for more info.
     */
    public async runServer(args: string[]) {
        let options = this.parseArguments(args)

        this.debugEnabled = options.debug

        let listenOnAllHosts = options.host === "*"
        let baseUrl = `http://${options.host}:${options.port}`

        this.config = this.readConfig(options.config)

        this.configureAws()
        this.configureServer(options)
        this.setupAlbTargetListeners()

        // health check endpoint for testing
        this.expressApp.get("/", (_, res) => res.status(204).send())
        this.expressApp.all("*", (req, res) => {
            let errMessage = `Request does not match any configured ALB target group: ${req.path}`

            if (this.debugEnabled) {
                this.log(errMessage)
            }

            res.status(400).send({
                error: "Request does not match any configured ALB target group"
            })
        })

        await this.startServer(options.host, options.port, listenOnAllHosts)

        this.log(`Listening for HTTP requests on ${baseUrl} ...`)
    }

    private log(message: string, ...args: any[]) {
        console.log(`${new Date().toISOString()} lambda-alb - ${message}`, ...args)
    }

    private parseArguments(args: string[]): Options {
        if (args && (args.includes("--debug") || args.includes("-d"))) {
            this.log("Command line arguments: %s", args)
        }

        let options = commandLineArgs(AlbApp.APP_OPTIONS, {
            argv: args
        }) as Options

        if (!options.config || options.config.trim() === "") {
            throw new Error("--config or -c option must be specified")
        }

        if (!existsSync(options.config)) {
            throw new Error(`Config file '${options.config}' not found`)
        }

        return options
    }

    private readConfig(configPath: PathLike): AlbConfig {
        return JSON.parse(readFileSync(configPath, "utf8"))
    }

    private configureServer(options: Options) {
        this.log("CORS origin set to: %s", options.corsOrigin)

        this.expressApp.use(cors({
            origin: options.corsOrigin
        }))

        // setup body parser to capture request bodies
        this.expressApp.use(rawBodyParser({
            limit: AlbApp.MAX_REQUEST_BODY_SIZE,
            type: r => true
        }))

        this.log(
            "WARNING: To simulate an AWS ALB or Application Gateway the max size for requests is limited to %s",
            AlbApp.MAX_REQUEST_BODY_SIZE
        )
    }

    private configureAws() {
        let config: ClientConfiguration = {}

        if (this.config.region && this.config.region.trim() !== "") {
            config.region = this.config.region
        }

        AWS.config.update(config)

        if (this.config.lambdaEndpoint && this.config.lambdaEndpoint.trim() !== "") {
            config.endpoint = this.config.lambdaEndpoint
        }

        this.lambdaClient = new AWS.Lambda(config)
    }

    private setupAlbTargetListeners() {
        let self = this

        for (let targetKey in this.config.targets) {
            if (!this.config.targets.hasOwnProperty(targetKey)) {
                continue
            }

            let target: AlbTarget = this.config.targets[targetKey]
            let basePath = target.routeUrl ? target.routeUrl : `/${targetKey}`

            if (basePath === "/") {
                throw new Error(`Invalid route URL '/' for lambda target '${targetKey}'`)
            }

            this.log("ALB target configured for lambda '%s' @ route: %s", target.lambdaName, basePath)

            this.expressApp.all(
                `${basePath}*`,
                (req, res) => self.handleHttpRequest(self, target, basePath, req, res)
            )
        }
    }

    private async handleHttpRequest(
        self: AlbApp,
        target: AlbTarget,
        basePath: string,
        request: Request,
        response: Response
    ) {
        try {
            let apiRequestEvent = await self.mapRequestToApiEvent(request, basePath)
            let apiResponse = await self.run(target, apiRequestEvent, {})

            self.forwardApiResponse(apiResponse, response)
        } catch (ex) {
            if (this.debugEnabled) {
                this.log("Target lambda '%s' invocation error", target.lambdaName)
                console.dir(ex)
            }

            response.status(503)
                .send({
                    error: `Target lambda '${target.lambdaName}' invocation error:\n${JSON.stringify(ex)}`
                })
        }
    }

    private async mapRequestToApiEvent(request: Request, basePath: string): Promise<AlbRequest> {
        this.log("Mapping express request to AWS model")

        let apiRequest = new AlbRequest()

        apiRequest.httpMethod = request.method
        apiRequest.path = request.path.substr(basePath.length)

        if (apiRequest.path.trim() === "") {
            apiRequest.path = "/"
        }

        Object.keys(request.headers)
            .forEach(h => apiRequest.headers[h] = request.headers[h])
        Object.keys(request.query)
            .forEach(q => apiRequest.queryStringParameters[q] = request.query[q])

        if (!AlbApp.HTTP_METHODS_WITH_ENTITY.includes(request.method)) {
            return apiRequest
        }

        let body = request.body as Buffer

        if (AlbApp.PLAIN_CONTENT_TYPES.some(contentType => request.is(contentType))) {
            apiRequest.body = body.toString()
            apiRequest.isBase64Encoded = false
        } else {
            apiRequest.body = body.toString("base64")
            apiRequest.isBase64Encoded = true
        }

        return apiRequest
    }

    private async run(target: AlbTarget, request: AlbRequest, context: any): Promise<AlbResponse> {
        let contextBuffer = Buffer.from(JSON.stringify(context))
        let lambaRequest: InvocationRequest = {
            ClientContext: contextBuffer.toString("base64"),
            FunctionName : target.lambdaName,
            InvocationType : "RequestResponse",
            LogType : "None",
            Payload: JSON.stringify(request),
            Qualifier: target.versionOrAlias
        }

        this.log(
            "Invoking AWS Lambda '%s'%s. Path: %s",
            target.lambdaName,
            target.versionOrAlias ? `, using qualifier '${target.versionOrAlias}'` : "",
            request.path
        )

        if (this.debugEnabled) {
            let loggableRequest = JSON.parse(JSON.stringify(request)) as AlbRequest

            if (loggableRequest.isBase64Encoded) {
                loggableRequest.body = `${loggableRequest.body.substr(0, 32)}...`
            }

            console.dir(loggableRequest)
        }

        return await (new Promise((resolve, reject) => {
            this.lambdaClient.invoke(lambaRequest, (error, data) => {
                if (error) {
                    reject(error)
                    return
                }

                resolve(
                    JSON.parse(data.Payload as string)
                )
            })
        }))
    }

    private forwardApiResponse(apiResponse: AlbResponse, response: Response) {
        this.log("Mapping AWS response model to express response")

        if (this.debugEnabled) {
            let loggableResponse = JSON.parse(JSON.stringify(apiResponse)) as AlbResponse

            if (loggableResponse.isBase64Encoded) {
                loggableResponse.body = `${loggableResponse.body.substr(0, 32)}...`
            }

            console.dir(loggableResponse)
        }

        let headers = apiResponse.headers

        response.status(apiResponse.statusCode)

        Object.keys(headers).forEach(h => response.header(h, headers[h]))

        if (apiResponse.isBase64Encoded) {
            response.contentType(
                apiResponse.headers["content-type"] || "application/octet-stream"
            )

            response.end(
                Buffer.from(apiResponse.body, "base64")
            )
        } else {
            response.send(apiResponse.body)
        }
    }

    private async startServer(host: string, port: number, listenOnAllHosts: boolean) {
        await new Promise<Server> ((resolve, reject) => {
            try {
                if (listenOnAllHosts) {
                    this.log("Listening on all hosts")

                    this.server = this.expressApp.listen(port, resolve)
                } else {
                    this.log("Listening on host: %s", host)

                    this.server = this.expressApp.listen(
                        port,
                        host,
                        resolve
                    )
                }
            } catch (ex) {
                reject(ex)
            }
        })
    }

    public async stopServer() {
        if (!this.server) {
            throw new Error("stopServer can only be called after runServer has been called and has completed")
        }

        this.log("Server shutting down")

        await new Promise<void>((resolve, reject) => {
            try {
                this.server.close(() => resolve())
            } catch (ex) {
                reject(ex)
            }
        })
    }
}

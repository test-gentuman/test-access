const core = require('@actions/core');
const aws = require('aws-sdk');

const {ECS, waitUntilTasksRunning, waitUntilTasksStopped} = require('@aws-sdk/client-ecs');

const smoketail = require('smoketail')

const main = async () => {
    try {
        // Setup AWS clients
        const ecs = new ECS({
            customUserAgent: 'github-action-aws-ecs-run-task',
        });

        // Inputs: Required
        const cluster = core.getInput('cluster', {required: true});
        const taskDefinition = core.getInput('task-definition', {required: true});
        const subnets = core.getMultilineInput('subnet-ids', {required: true});
        const securityGroups = core.getMultilineInput('security-group-ids', {required: true});

        // Inputs: Optional
        const tailLogs = core.getBooleanInput('tail-logs', {required: false});
        const assignPublicIp = core.getInput('assign-public-ip', {required: false});
        const overrideContainer = core.getInput('override-container', {required: false});
        const overrideContainerCommand = core.getMultilineInput('override-container-command', {required: false});
        const overrideContainerEnvironment = core.getMultilineInput('override-container-environment', {required: false});

        // Inputs: Waiters
        const taskWaitUntilStopped = core.getBooleanInput('task-wait-until-stopped', {required: false});
        const taskStartMaxWaitTime = parseInt(core.getInput('task-start-max-wait-time', {required: false}));
        const taskStoppedMaxWaitTime = parseInt(core.getInput('task-stopped-max-wait-time', {required: false}));
        const taskCheckStateDelay = parseInt(core.getInput('task-check-state-delay', {required: false}));

        // Build Task parameters
        const taskRequestParams = {
            count: 1,
            cluster,
            taskDefinition,
            launchType: 'FARGATE',
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets,
                    assignPublicIp,
                    securityGroups
                },
            },
        };

        // Overrides if defined
        if (overrideContainer) {
            let overrides = {
                name: overrideContainer,
            }

            if (overrideContainerCommand.length) {
                core.debug(`overrideContainer and overrideContainerCommand has been specified. Overriding.`);

                // Iterate over each item in the array and check for line appender character
                core.debug(`Parsing overrideContainerCommand and merging line appender strings.`);
                overrideContainerCommand.map((x, i, arr) => {
                    if (x.endsWith('\\')) {
                        // Remove line appender character
                        arr[i] = x.replace(/\\$/, '')

                        // Check if not the last item in array
                        if (arr.length - 1 !== i) {
                            // Prepend the current item to the next item and set current item to null
                            arr[i + 1] = arr[i] + arr[i + 1]
                            arr[i] = null
                        }
                    }
                })

                // Filter out any null values
                const parsedCommand = overrideContainerCommand.filter(x => x)
                core.debug(`Resulting command: ${JSON.stringify(parsedCommand)}`)

                overrides.command = parsedCommand
            }

            if (overrideContainerEnvironment.length) {
                core.debug(`overrideContainer and overrideContainerEnvironment has been specified. Overriding.`);
                overrides.environment = overrideContainerEnvironment.map(x => {
                    const parts = x.split(/=(.*)/)
                    return {
                        name: parts[0],
                        value: parts[1]
                    }
                })
            }

            taskRequestParams.overrides = {
                containerOverrides: [overrides],
            }
        }

        // Start task
        core.debug(JSON.stringify(taskRequestParams))
        core.debug(`Starting task.`)
        let task = await ecs.runTask(taskRequestParams);

        // Get taskArn and taskId
        const taskArn = task.tasks[0].taskArn;
        const taskId = taskArn.split('/').pop();
        core.saveState('task-arn', taskArn);
        core.saveState('task-id', taskId);
        core.saveState('task-finished', true);
        core.saveState('ecs-session', ecs);
        core.setOutput('task-arn', taskArn);
        core.setOutput('task-id', taskId);
        core.info(`Starting Task with ARN: ${taskArn}\n`);

        try {
            core.debug(`Waiting for task to be in running state. Waiting for ${taskStartMaxWaitTime} seconds.`);
            await waitUntilTasksRunning({
                client: ecs,
                maxWaitTime: taskStartMaxWaitTime,
                maxDelay: taskCheckStateDelay,
                minDelay: taskCheckStateDelay,
            }, {cluster, tasks: [taskArn]});
        } catch (error) {
            core.setFailed(`Task did not start successfully. Error: ${error.name}. State: ${error.state}.`);
            core.saveState('task-finished', true);
            return;
        }
        core.saveState('task-finished', false);
        // If taskWaitUntilStopped is false, we can bail out here because we can not tail logs or have any
        // information on the exitCodes or status of the task
        if (!taskWaitUntilStopped) {
            core.info(`Task is running. Exiting without waiting for task to stop.`);
            core.saveState('task-finished', true);
            return;
        }

        // Get logging configuration
        let logFilterStream = null;
        let logOutput = '';

        // Only create logFilterStream if tailLogs is enabled, and we wait for the task to stop in the pipeline
        if (tailLogs) {
            core.debug(`Logging enabled. Getting logConfiguration from TaskDefinition.`)
            let taskDef = await ecs.describeTaskDefinition({taskDefinition: taskDefinition});
            taskDef = taskDef.taskDefinition

            // Iterate all containers in TaskDef and search for given container with awslogs driver
            if (taskDef && taskDef.containerDefinitions) {
                taskDef.containerDefinitions.some((container) => {
                    core.debug(`Looking for logConfiguration in container '${container.name}'.`);

                    // If overrideContainer is passed, we want the logConfiguration for that container
                    if (overrideContainer && container.name !== overrideContainer) {
                        return false;
                    }

                    // Create a CWLogFilterStream if logOptions are found
                    if (container.logConfiguration && container.logConfiguration.logDriver === 'awslogs') {
                        const logStreamName = [container.logConfiguration.options['awslogs-stream-prefix'], container.name, taskId].join('/')
                        core.debug(`Found matching container with 'awslogs' logDriver. Creating LogStream for '${logStreamName}'`);

                        logFilterStream = new smoketail.CWLogFilterEventStream(
                            {
                                logGroupName: container.logConfiguration.options['awslogs-group'],
                                logStreamNames: [logStreamName],
                                startTime: Math.floor(+new Date() / 1000),
                                followInterval: 3000,
                                follow: true
                            },
                            {region: container.logConfiguration.options['awslogs-region']}
                        );

                        logFilterStream.on('error', function (error) {
                            core.error(error.message);
                            core.debug(error.stack);
                        });

                        logFilterStream.on('data', function (eventObject) {
                            const logLine = `${new Date(eventObject.timestamp).toISOString()}: ${eventObject.message}`
                            core.info(logLine);
                            logOutput += logLine + '\n';
                        });

                        return true;
                    }
                });
            }
        }

        try {
            core.debug(`Waiting for task to finish. Waiting for ${taskStoppedMaxWaitTime} seconds.`);
            await waitUntilTasksStopped({
                client: ecs,
                maxWaitTime: taskStoppedMaxWaitTime,
                maxDelay: taskCheckStateDelay,
                minDelay: taskCheckStateDelay,
            }, {
                cluster,
                tasks: [taskArn],
            });
        } catch (error) {
            core.setFailed(`Task did not stop successfully. Error: ${error.name}. State: ${error.state}.`);
        }

        // Close LogStream and store output
        if (logFilterStream !== null) {
            core.debug(`Closing logStream.`);
            logFilterStream.close();

            // Export log-output
            core.setOutput('log-output', logOutput);
        }

        // Describe Task to get Exit Code and Exceptions
        core.debug(`Process exit code and exception.`);
        task = await ecs.describeTasks({cluster, tasks: [taskArn]});
        core.saveState('task-finished', true);
        // Get exitCode
        if (task.tasks[0].containers[0].exitCode !== 0) {
            core.info(`Task failed, see details on Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${cluster}/tasks/${taskId}/details`);
            core.setFailed(task.tasks[0].stoppedReason)
        }
    } catch (error) {
        core.setFailed(error.message);
        core.debug(error.stack);
    }
};

main();
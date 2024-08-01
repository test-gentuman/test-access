const core = require('@actions/core');
const aws = require('aws-sdk');

const {ECS, waitUntilTasksRunning} = require('@aws-sdk/client-ecs');

const main = async () => {
    try {
        core.info('Post run blah blah.');
        if (core.getState('task-finishef') === 'true') {
            core.info('Task already finished. Exiting.');
            return;
        }
        const ecs = new ECS({
            customUserAgent: 'github-action-aws-ecs-run-task',
        });

        const cluster = core.getInput('cluster', {required: true});
        const task = core.getState('task-arn');


        core.info(`Wait for task to run. Just in case it is still starting.`)

        await waitUntilTasksRunning({
            client: ecs,
            maxWaitTime: 300,
            maxDelay: 5,
            minDelay: 5,
        }, {cluster, tasks: [task]});

        core.info(`Stopping task as run ended.`)

        const taskStopParams = {
            cluster: cluster,
            task: core.getState('task-id'),
            reason: 'Task was stopped by the action.'
        }
        let response = await ecs.stopTask(taskStopParams);
        core.info("Response from ECS:" + response.task.stoppedReason);
    } catch (e) {
        core.info(error.stack);
    }
};

main();
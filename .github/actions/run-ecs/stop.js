const core = require('@actions/core');
const aws = require('aws-sdk');

const {ECS} = require('@aws-sdk/client-ecs');

const main = async () => {
    try {
        core.info('Post ECS Task Run.');
        if (core.getState('task-finished') === 'true') {
            core.info('ECS task already finished. Exiting.');
            return;
        }
        const ecs = new ECS({
            customUserAgent: 'github-action-aws-ecs-run-task',
        });

        const cluster = core.getInput('cluster', {required: true});

        core.info(`Stopping ECS task as run ended.`)

        const taskStopParams = {
            cluster: cluster,
            task: core.getState('task-id'),
            reason: 'Task was stopped by the github action.'
        }
        let response = await ecs.stopTask(taskStopParams);
        core.info("Response from ECS: " + response.task.stoppedReason);
    } catch (e) {
        core.info(error.stack);
    }
};

main();
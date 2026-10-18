export default async function () {
  await globalThis.__ROS_PG__?.stop();
}

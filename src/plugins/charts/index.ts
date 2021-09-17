export default class Plugin {
  public author = 'zerquix18';
  public version = '0.1.0';
  public name = 'Charts';
  public defaultParams = {
    total_votes_per_day: {
      enabled: true
    },
    voting_power_per_day: {
      enabled: true
    },
    voting_power_per_address: {
      enabled: true
    }
  };
}

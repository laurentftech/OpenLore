object Service {
  def run(): Int = helper()
  def helper(): Int = 1
}

class Client {
  def go(): Int = Service.run()
}

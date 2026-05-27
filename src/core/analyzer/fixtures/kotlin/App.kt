class Service {
    fun run() {
        helper()
    }
    fun helper() { }
}

fun String.shout(): String {
    return this.uppercase()
}

fun main() {
    val s = Service()
    s.run()
}

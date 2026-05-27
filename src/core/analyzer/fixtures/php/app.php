<?php
namespace App;

class Service {
    function run() {
        $this->helper();
        Util::save("hi");
    }
    function helper() { }
}

class Util {
    static function save($m) { }
}

function boot() {
    helper_free();
}
function helper_free() { }
